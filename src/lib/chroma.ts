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

/** True when Chroma answers its heartbeat. */
export async function heartbeat(): Promise<boolean> {
  try {
    await chroma.heartbeat();
    return true;
  } catch {
    return false;
  }
}

/** Filter → Chroma's `where`. Chroma wants `$and` only when there are two or more conditions. */
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

  private async collection(): Promise<Collection> {
    if (!(await heartbeat())) {
      throw new Error(
        `Chroma is not reachable at ${config.chromaUrl}. Start it: podman compose up -d  (or use --store json)`,
      );
    }
    // cosine space: Chroma returns distance = 1 − cosine similarity
    return chroma.getOrCreateCollection({
      name: this.name,
      embeddingFunction: null,
      configuration: { hnsw: { space: "cosine" } },
    });
  }

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

  async count(): Promise<number> {
    return (await this.collection()).count();
  }

  async editions(): Promise<string[]> {
    const col = await this.collection();
    const res = await col.get({ include: [IncludeEnum.metadatas] });
    return [...new Set(res.metadatas.map((m) => String(m?.edition)))].sort();
  }

  async reset(): Promise<void> {
    try {
      await chroma.deleteCollection({ name: this.name });
    } catch {
      // did not exist
    }
  }
}
