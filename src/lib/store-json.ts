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

/**
 * What it does: checks if a record matches the edition and access filter.
 *
 * Does this record pass the metadata filter? Shared by the JSON store and the tests.
 */
export function passes(r: { edition: string; access: string }, filter: Filter = {}): boolean {
  if (filter.edition && r.edition !== filter.edition) return false;
  if (filter.access && !filter.access.includes(r.access)) return false;
  return true;
}

export class JsonStore implements VectorStore {
  kind: StoreKind = "json";

  constructor(private readonly file = FILE) {}

  /** What it does: reads every record from the JSON file, or an empty list if it is missing. */
  private async all(): Promise<VectorChunk[]> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as VectorChunk[];
    } catch {
      return [];
    }
  }

  /** What it does: keeps the other editions and saves this edition's new records to the JSON file. */
  async replaceEdition(edition: string, records: VectorChunk[]): Promise<void> {
    const kept = (await this.all()).filter((r) => r.edition !== edition);
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify([...kept, ...records]));
  }

  /** What it does: filters the records, scores every one by cosine, and returns the k best. */
  async query(vector: number[], k: number, filter?: Filter): Promise<Hit[]> {
    return (await this.all())
      .filter((r) => passes(r, filter))
      .map(({ vector: v, ...chunk }) => ({ chunk, score: cosine(vector, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** What it does: returns how many records are in the JSON file. */
  async count(): Promise<number> {
    return (await this.all()).length;
  }

  /** What it does: lists the editions in the JSON file, sorted. */
  async editions(): Promise<string[]> {
    return [...new Set((await this.all()).map((r) => r.edition))].sort();
  }

  /** What it does: empties the JSON file. */
  async reset(): Promise<void> {
    await writeFile(this.file, "[]").catch(() => undefined);
  }
}
