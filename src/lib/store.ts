// One interface, two vector stores. Step 5 fills one; step 6 searches it. The rest of the code never
// knows which one it is talking to — which is how we can show that the ranking does not change when
// we move from our JSON file to a real vector database.
import { config, type StoreKind } from "./config.js";
import { ChromaStore } from "./chroma.js";
import { JsonStore } from "./store-json.js";
import type { Filter, Hit, VectorChunk } from "./types.js";

export interface VectorStore {
  kind: StoreKind;
  /** Replace every record of one edition with these. Other editions stay untouched. */
  replaceEdition(edition: string, records: VectorChunk[]): Promise<void>;
  /** The k records closest to `vector` that pass `filter`, best first. */
  query(vector: number[], k: number, filter?: Filter): Promise<Hit[]>;
  count(): Promise<number>;
  /** Editions present in the store, sorted — "latest" is the last one. */
  editions(): Promise<string[]>;
  /** Delete everything. */
  reset(): Promise<void>;
}

/** Open the store chosen by `--store` / `STORE` (default: chroma). */
export function openStore(kind: StoreKind = config.store): VectorStore {
  if (kind === "json") return new JsonStore();
  if (kind === "chroma") return new ChromaStore();
  throw new Error(`Unknown store "${kind}". Use --store chroma or --store json.`);
}
