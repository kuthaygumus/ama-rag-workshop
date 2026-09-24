// STEP 5 — STORE
// Gate: until now the "database" was a JSON file, and a search compared the question with EVERY
// vector. Fine for 100 chunks; at a million, every question does a million comparisons. A vector
// database keeps an index (HNSW: a graph of neighbours) and visits only the neighbourhood.
//
// What it stores per chunk: the vector, the text (a vector cannot be turned back into words) and the
// metadata (edition, access …) that step 6 filters on.
import { config } from "../lib/config.js";
import { readStep, writeStep } from "../lib/data.js";
import { done, green, line, more, stepHeader, yellow } from "../lib/log.js";
import { embed } from "../lib/ollama.js";
import { JsonStore } from "../lib/store-json.js";
import { openStore, type VectorStore } from "../lib/store.js";
import type { StoreKind } from "../lib/config.js";
import type { Vectors } from "./4-embed.js";

export interface StoreReceipt {
  store: StoreKind;
  collection: string;
  edition: string;
  embedModel: string;
  added: number;
  total: number;
  editions: string[];
}

/**
 * Same question, two stores: the ids brute force ranks first, and the ids the store ranks first.
 * Identical lists mean the database changed the speed and the scale — not the answer.
 */
async function compareWithBruteForce(store: VectorStore, vectors: Vectors): Promise<void> {
  const { vectors: [q] } = await embed([config.dayQuestion]);
  const brute = new JsonStore("data/.brute-force.json");
  await brute.replaceEdition(vectors.chunks[0]!.edition, vectors.chunks);
  const filter = { edition: vectors.chunks[0]!.edition };
  const a = (await brute.query(q!, 5, filter)).map((h) => h.chunk.id);
  const b = (await store.query(q!, 5, filter)).map((h) => h.chunk.id);
  more("");
  more(`the day's question, top-5 ids:`);
  more(`  JSON (brute force)  ${a.join("  ")}`);
  more(`  ${store.kind.padEnd(18)}  ${b.join("  ")}`);
  const same = a.join() === b.join();
  more(same ? green("  identical ✓ — the database changes the scale, not the ranking") : yellow("  different order — look at the scores: near-ties can swap"));
}

/**
 * Run step 5: put data/4-vectors.json into the store, replacing that edition's old records.
 * @param kind "chroma" (default) or "json" — see --store
 */
export async function run(kind: StoreKind = config.store): Promise<StoreReceipt> {
  stepHeader(5, "store");
  const t0 = performance.now();
  const input = await readStep<Vectors>("4-vectors", "3-chunks");
  const edition = input.data.chunks[0]?.edition ?? config.edition;
  const store = openStore(kind);
  line("IN", `data/4-vectors.json  (${input.data.chunks.length} vectors, edition ${edition})`);
  line(
    "WHAT",
    kind === "chroma"
      ? `replace edition ${edition} in Chroma collection "${config.collection}" (HNSW index, cosine)`
      : `replace edition ${edition} in data/store.json (no index: every search visits every vector)`,
  );
  await store.replaceEdition(edition, input.data.chunks);
  const receipt: StoreReceipt = {
    store: kind,
    collection: config.collection,
    edition,
    embedModel: input.data.embedModel,
    added: input.data.chunks.length,
    total: await store.count(),
    editions: await store.editions(),
  };
  line("OUT", `${receipt.added} records added · ${receipt.total} in the store · editions: ${receipt.editions.join(", ")}`);
  if (kind === "chroma") await compareWithBruteForce(store, input.data);
  const file = await writeStep("5-store", receipt, input.hash);
  done(t0, file);
  return receipt;
}
