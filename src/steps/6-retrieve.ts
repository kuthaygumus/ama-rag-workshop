// STEP 6 — RETRIEVE
// Gate: the question is words, the store holds vectors — they cannot be compared. So the question
// goes through the SAME embedding model, and we ask the store for the k closest chunks.
//
// "The k closest" is one retrieval method of several. Metadata filters decide who may compete at all:
// an old edition should not answer a question about today, and a salary table should not reach
// someone who is not allowed to read it. Filters run INSIDE the search, not after it.
import { config } from "../lib/config.js";
import { StaleInputError, readStep, writeStep } from "../lib/data.js";
import { dim, done, line, more, preview, stepHeader } from "../lib/log.js";
import { embed } from "../lib/ollama.js";
import { openStore, type VectorStore } from "../lib/store.js";
import type { Filter, Hit } from "../lib/types.js";
import type { StoreReceipt } from "./5-store.js";

// TOGGLE edition filter
const EDITION_FILTER: "latest" | "all" = "latest"; // default — only the newest edition in the store may answer
// const EDITION_FILTER: "latest" | "all" = "all"; // alternative — every edition competes, old ones included

// TOGGLE access filter — who is asking?
const ASKER_MAY_READ: string[] | undefined = ["all"]; // default — a regular employee: public documents only
// const ASKER_MAY_READ: string[] | undefined = undefined; // alternative — nobody checks: every document reaches everyone

export interface RetrieveOptions {
  store: VectorStore;
  k?: number;
  /** "latest", "all", or one edition by name (the eval pins the edition its gold set was written for). */
  edition?: string;
  access?: string[] | undefined;
}

export interface Retrieved {
  question: string;
  filter: Filter;
  k: number;
  /** The k chunks handed on, best first. */
  hits: Hit[];
  /** The next few, just below the cut — shown so you can see what almost made it. */
  below: Hit[];
  embedMs: number;
  searchMs: number;
}

/**
 * What it does: embeds the question and asks the store for the closest chunks that pass the filters.
 *
 * Embed the question and fetch the k closest chunks that pass the filters.
 * @param question plain text, any language
 * @returns hits above the cut and the three just below it
 */
export async function retrieve(question: string, o: RetrieveOptions): Promise<Retrieved> {
  const k = o.k ?? config.topK;
  const edition = o.edition ?? EDITION_FILTER;
  const access = "access" in o ? o.access : ASKER_MAY_READ;
  const filter: Filter = {};
  if (edition === "latest") filter.edition = (await o.store.editions()).at(-1);
  else if (edition !== "all") filter.edition = edition;
  if (access) filter.access = access;

  let t = performance.now();
  const { vectors: [q] } = await embed([question]);
  const embedMs = Math.round(performance.now() - t);
  t = performance.now();
  const ranked = await o.store.query(q!, k + 3, filter);
  const searchMs = Math.round(performance.now() - t);
  return { question, filter, k, hits: ranked.slice(0, k), below: ranked.slice(k), embedMs, searchMs };
}

/**
 * What it does: builds a short label for a hit: document title and section numbers.
 *
 * "Annual Leave Policy › §3"
 */
export const where = (h: Hit) => `${h.chunk.title} › §${h.chunk.sections.join(",")}`;

/**
 * What it does: prints the ranked hits, with a line showing where the top k ends.
 *
 * Print the ranked list with the cut line.
 */
export function printRanked(r: Retrieved): void {
  /** What it does: builds one printed line for a hit: rank, score, id, title and a text preview. */
  const row = (h: Hit, i: number) =>
    `${String(i + 1).padStart(2)}  ${h.score.toFixed(3)}  ${h.chunk.id.padEnd(24)} ${preview(where(h), 44).padEnd(44)} ${dim(preview(h.chunk.text.replace(/^\[.*?\]\n/, ""), 40))}`;
  r.hits.forEach((h, i) => more(row(h, i)));
  more(dim(`─ ─ ─ cut: k = ${r.k} ─ ─ ─`));
  r.below.forEach((h, i) => more(dim(row(h, r.k + i))));
}

/**
 * What it does: reads the step 5 receipt and stops if the store used a different embedding model.
 *
 * Guard: the store must hold vectors from the current data and the same embedding model.
 */
export async function storeReceipt(): Promise<StoreReceipt> {
  const receipt = (await readStep<StoreReceipt>("5-store", "4-vectors")).data;
  if (receipt.embedModel !== config.embedModel) {
    throw new StaleInputError(
      `The store was filled with ${receipt.embedModel} vectors, but questions would be embedded with ${config.embedModel}. ` +
        `Vectors from two models live in different spaces — run steps 4 and 5 again.`,
    );
  }
  return receipt;
}

/**
 * What it does: finds the closest chunks for one question, prints them, and saves data/6-retrieved.json.
 *
 * Run step 6 for one question and write data/6-retrieved.json.
 * @param question defaults to the day's question
 * @param overrides filter settings that replace the TOGGLE lines (used by capture)
 */
export async function run(question = config.dayQuestion, overrides: Partial<RetrieveOptions> = {}): Promise<Retrieved> {
  stepHeader(6, "retrieve");
  const t0 = performance.now();
  const receipt = await storeReceipt();
  const store = openStore(receipt.store);
  const r = await retrieve(question, { store, ...overrides });
  line("IN", question);
  line(
    "WHAT",
    `embed the question (${config.embedModel}, ${r.embedMs} ms) · ask ${receipt.store} for the ${r.k} closest · filter ${JSON.stringify(r.filter)}`,
  );
  line("OUT", `${r.hits.length} chunks handed on · search ${r.searchMs} ms`);
  printRanked(r);
  const file = await writeStep("6-retrieved", r, (await readStep("5-store")).hash);
  done(t0, file);
  return r;
}
