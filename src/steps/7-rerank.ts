// STEP 7 — RERANK
// Gate: the right chunk is in the top 5, but not always at the top — and only the top 3 go into the
// prompt. Vector search compares two vectors made SEPARATELY (question alone, chunk alone). A reranker
// reads the question and the chunk TOGETHER and judges one pair at a time — slower, more careful.
//
// Here the reranker is our chat model, asked for a 0–10 relevance score per chunk ("pointwise").
// A dedicated cross-encoder reranker does the same job faster; the idea is identical.
import { config } from "../lib/config.js";
import { readStep, writeStep } from "../lib/data.js";
import { dim, done, line, more, stepHeader } from "../lib/log.js";
import { generate } from "../lib/ollama.js";
import type { Hit } from "../lib/types.js";
import { where, type Retrieved } from "./6-retrieve.js";

// TOGGLE rerank
const RERANK = true; // default
// const RERANK = false; // alternative

/** The reranker reads at most this much of each chunk: enough to judge, cheap enough to repeat 5×. */
const READ_CHARS = 700;

export interface Ranked extends Hit {
  /** The reranker's 0–10 score (undefined when rerank is off). */
  relevance?: number;
  /** Position before reranking, 1-based. */
  was: number;
}

export interface Reranked {
  question: string;
  rerank: boolean;
  ranked: Ranked[];
  /** How many of `ranked` go into the prompt. */
  keep: number;
  ms: number;
  /** Hits whose score equals another hit's score — the reranker could not tell them apart. */
  ties: number;
}

const SCHEMA = { type: "object", properties: { score: { type: "integer", minimum: 0, maximum: 10 } }, required: ["score"] };

/**
 * Score one (question, chunk) pair with the chat model.
 * @returns 0 = unrelated … 10 = the answer is right here
 */
export async function relevance(question: string, text: string): Promise<number> {
  const prompt =
    `SORU: ${question}\n\nMETİN:\n${text.slice(0, READ_CHARS)}\n\n` +
    `Bu metin soruyu cevaplamak için gereken bilgiyi içeriyor mu? ` +
    `0 (tamamen ilgisiz) ile 10 (cevap tam olarak bu metinde) arasında bir puan ver.`;
  const gen = await generate(prompt, { system: "Sen bir arama sonucu değerlendiricisin. Yalnızca JSON döndür.", format: SCHEMA });
  const score = Number((JSON.parse(gen.text) as { score: unknown }).score);
  return Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0;
}

/**
 * Re-order the retrieved hits by the reranker's score (vector score breaks ties).
 * @param on defaults to the TOGGLE above
 */
export async function rerank(r: Retrieved, on: boolean = RERANK): Promise<Reranked> {
  const t0 = performance.now();
  let ranked: Ranked[] = r.hits.map((h, i) => ({ ...h, was: i + 1 }));
  if (on) {
    const scores = await Promise.all(r.hits.map((h) => relevance(r.question, h.chunk.text)));
    ranked = ranked
      .map((h, i) => ({ ...h, relevance: scores[i] }))
      .sort((a, b) => b.relevance! - a.relevance! || b.score - a.score);
  }
  const ties = on ? ranked.filter((h) => ranked.some((o) => o !== h && o.relevance === h.relevance)).length : 0;
  return { question: r.question, rerank: on, ranked, keep: config.contextK, ms: Math.round(performance.now() - t0), ties };
}

/** Print before → after with the keep line. */
export function printReranked(rr: Reranked): void {
  rr.ranked.forEach((h, i) => {
    const move = h.was === i + 1 ? "  " : h.was > i + 1 ? "▲ " : "▼ ";
    const rel = h.relevance === undefined ? "" : `rel ${String(h.relevance).padStart(2)}  `;
    const text = `${String(i + 1).padStart(2)}  ${move}was ${h.was}  ${rel}vec ${h.score.toFixed(3)}  ${h.chunk.id.padEnd(24)} ${where(h)}`;
    more(i < rr.keep ? text : dim(text));
    if (i === rr.keep - 1) more(dim(`─ ─ ─ into the prompt: top ${rr.keep} ─ ─ ─`));
  });
}

/** Run step 7 on data/6-retrieved.json and write data/7-reranked.json. */
export async function run(on: boolean = RERANK): Promise<Reranked> {
  stepHeader(7, "rerank");
  const t0 = performance.now();
  const input = await readStep<Retrieved>("6-retrieved", "5-store");
  line("IN", `data/6-retrieved.json  (${input.data.hits.length} chunks for "${input.data.question}")`);
  line(
    "WHAT",
    on
      ? `${config.chatModel} scores each (question, chunk) pair 0–10 · re-sort · keep the top ${config.contextK}`
      : `rerank is OFF · keep the top ${config.contextK} in vector order`,
  );
  const rr = await rerank(input.data, on);
  line("OUT", on ? `${rr.ranked.length} chunks scored in ${rr.ms} ms · ties: ${rr.ties} of ${rr.ranked.length}` : "order unchanged");
  printReranked(rr);
  const file = await writeStep("7-reranked", rr, input.hash);
  done(t0, file);
  return rr;
}
