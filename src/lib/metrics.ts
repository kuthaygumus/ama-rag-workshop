// Retrieval metrics at SECTION level: a chunk counts for every section it touches.
import type { Hit } from "./types.js";

/**
 * What it does: turns search hits into a list of section keys, best first, without repeats.
 *
 * Hits → section keys ("hr-leave#3"), best first, each key once.
 */
export function sectionRanking(hits: Hit[]): string[] {
  const keys = hits.flatMap((h) => h.chunk.sections.map((s) => `${h.chunk.docId}#${s}`));
  return [...new Set(keys)];
}

/**
 * What it does: compares a ranking with the gold sections and returns hit@1, recall and reciprocal rank.
 *
 * hit@1, recall@k and reciprocal rank for one question.
 */
export function score(ranking: string[], gold: string[], k: number): { hit1: number; recall: number; rr: number } {
  const first = ranking.findIndex((key) => gold.includes(key));
  return {
    hit1: first === 0 ? 1 : 0,
    recall: gold.filter((g) => ranking.slice(0, k).includes(g)).length / gold.length,
    rr: first < 0 ? 0 : 1 / (first + 1),
  };
}
