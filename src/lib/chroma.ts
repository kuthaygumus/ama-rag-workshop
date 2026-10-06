// The thinnest wrapper over the Chroma client that still reads as a lesson. We hand Chroma our own
// vectors (made with Ollama in step 4), so Chroma has no embedding function: it is storage plus
// nearest-neighbour search, nothing else. Bruno's 01-chroma folder looks at the same data over HTTP.
import { ChromaClient, IncludeEnum, type Collection, type Where } from "chromadb";
import { config, type StoreKind } from "./config.js";
import type { Filter, Hit, VectorChunk } from "./types.js";
import type { VectorStore } from "./store.js";

const url = new URL(config.chromaUrl);
export const chroma = new ChromaClient({
  host: url.hostname,
  port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  ssl: url.protocol === "https:",
});

/**
 * What it does: checks if the Chroma server is running and answers.
 *
 * True when Chroma answers its heartbeat.
 */
export async function heartbeat(): Promise<boolean> {
  try {
    await chroma.heartbeat();
    return true;
  } catch {
    return false;
  }
}

/**
 * What it does: turns our edition and access filter into the format Chroma wants.
 *
 * Filter → Chroma's `where`. Chroma wants `$and` only when there are two or more conditions.
 */
export function toWhere(filter: Filter = {}): Where | undefined {
  const conditions: Where[] = [];
  if (filter.edition) conditions.push({ edition: filter.edition });
  if (filter.access) conditions.push({ access: { $in: filter.access } });
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

export class ChromaStore implements VectorStore {
  kind: StoreKind = "chroma";

  constructor(private readonly name = config.collection) {}

  /** What it does: opens or creates our Chroma collection, and fails clearly if Chroma is down. */
  private async collection(): Promise<Collection> {
    if (!(await heartbeat())) {
      throw new Error(
        `Chroma is not reachable at ${config.chromaUrl}. Start it: podman compose up -d  (or use --store json)`,
      );
    }
    // cosine space: Chroma returns distance = 1 − cosine similarity
    /**
     * HNSW settings: we set only `space`. Chroma fills in the rest with its defaults
     * (see them in Bruno: collections → configuration_json → hnsw).
     * For a more accurate search, add more, for example { space: "cosine", ef_search: 200, max_neighbors: 32 }.
     * Higher means closer to exact, but slower. Checking every vector is brute force.
     * max_neighbors only applies when the collection is created: run npm run catchup -- 5.
     */
    return chroma.getOrCreateCollection({
      name: this.name,
      embeddingFunction: null,
      configuration: { hnsw: { space: "cosine" } },
    });
  }

  /** What it does: deletes one edition's old chunks, then adds the new ones in batches of 100. */
  async replaceEdition(edition: string, records: VectorChunk[]): Promise<void> {
    const col = await this.collection();
    await col.delete({ where: { edition } });
    for (let i = 0; i < records.length; i += 100) {
      const slice = records.slice(i, i + 100);
      await col.add({
        ids: slice.map((r) => r.id),
        embeddings: slice.map((r) => r.vector),
        documents: slice.map((r) => r.text),
        // metadata values must be plain strings/numbers — the section list becomes "2,3"
        metadatas: slice.map((r) => ({
          docId: r.docId,
          edition: r.edition,
          title: r.title,
          access: r.access,
          lang: r.lang,
          sections: r.sections.join(","),
        })),
      });
    }
  }

  /** What it does: asks Chroma for the k closest chunks that pass the filter, with cosine scores. */
  async query(vector: number[], k: number, filter?: Filter): Promise<Hit[]> {
    const col = await this.collection();
    const res = await col.query({
      queryEmbeddings: [vector],
      nResults: k,
      where: toWhere(filter),
      include: [IncludeEnum.documents, IncludeEnum.metadatas, IncludeEnum.distances],
    });
    return (res.ids[0] ?? []).map((id, i) => {
      const m = res.metadatas[0]?.[i] ?? {};
      return {
        score: 1 - (res.distances[0]?.[i] ?? 1),
        chunk: {
          id,
          docId: String(m.docId),
          edition: String(m.edition),
          title: String(m.title),
          access: String(m.access),
          lang: String(m.lang),
          sections: String(m.sections).split(","),
          text: res.documents[0]?.[i] ?? "",
        },
      };
    });
  }

  /** What it does: returns how many chunks are in the collection. */
  async count(): Promise<number> {
    return (await this.collection()).count();
  }

  /** What it does: lists the editions found in the collection, sorted. */
  async editions(): Promise<string[]> {
    const col = await this.collection();
    const res = await col.get({ include: [IncludeEnum.metadatas] });
    return [...new Set(res.metadatas.map((m) => String(m?.edition)))].sort();
  }

  /** What it does: deletes the whole collection, and does nothing if it does not exist. */
  async reset(): Promise<void> {
    try {
      await chroma.deleteCollection({ name: this.name });
    } catch {
      // did not exist
    }
  }
}
