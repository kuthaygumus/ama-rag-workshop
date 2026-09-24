// The simplest vector store that works: every record in one JSON file, and a search that compares the
// question with EVERY vector (brute force). Perfect for 100 chunks. At a million chunks, each question
// would do a million comparisons — that is the problem a vector database solves (step 5).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { cosine } from "./similarity.js";
import type { StoreKind } from "./config.js";
import type { Filter, Hit, VectorChunk } from "./types.js";
import type { VectorStore } from "./store.js";

const FILE = join(config.dataDir, "store.json");

/** Does this record pass the metadata filter? Shared by the JSON store and the tests. */
export function passes(r: { edition: string; access: string }, filter: Filter = {}): boolean {
  if (filter.edition && r.edition !== filter.edition) return false;
  if (filter.access && !filter.access.includes(r.access)) return false;
  return true;
}

export class JsonStore implements VectorStore {
  kind: StoreKind = "json";

  constructor(private readonly file = FILE) {}

  private async all(): Promise<VectorChunk[]> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as VectorChunk[];
    } catch {
      return [];
    }
  }

  async replaceEdition(edition: string, records: VectorChunk[]): Promise<void> {
    const kept = (await this.all()).filter((r) => r.edition !== edition);
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify([...kept, ...records]));
  }

  async query(vector: number[], k: number, filter?: Filter): Promise<Hit[]> {
    return (await this.all())
      .filter((r) => passes(r, filter))
      .map(({ vector: v, ...chunk }) => ({ chunk, score: cosine(vector, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }

  async editions(): Promise<string[]> {
    return [...new Set((await this.all()).map((r) => r.edition))].sort();
  }

  async reset(): Promise<void> {
    await writeFile(this.file, "[]").catch(() => undefined);
  }
}
