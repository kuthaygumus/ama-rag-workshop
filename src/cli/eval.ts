// npm run eval [-- --answers]
// "It felt better" is not a metric. Run ~20 questions with known answers (eval/gold.jsonl) through the
// retriever and count how often the right SECTION comes back.
//   hit@1     the first result is a right section
//   recall@k  share of the right sections found in the top k
//   MRR       1 / rank of the first right section, averaged (1.0 = always first)
//   --answers also generate every answer and check it contains the expected value (slower)
// Run it, flip a toggle (the chunker, a filter), re-ingest, run it again: now "better" has a number.
import { readFile } from "node:fs/promises";
import { config, cli } from "../lib/config.js";
import { writeStep } from "../lib/data.js";
import { banner, dim, green, line, more, red } from "../lib/log.js";
import { openStore } from "../lib/store.js";
import { score, sectionRanking } from "../lib/metrics.js";
import { retrieve, storeReceipt } from "../steps/6-retrieve.js";
import { rerank } from "../steps/7-rerank.js";
import { answer, isAbstain } from "../steps/8-answer.js";
import { exitOnError } from "./errors.js";

export interface Gold {
  id: string;
  query: string;
  gold_sections: string[];
  expect: string;
  type: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const NOT_RETRIEVAL = ["out-of-corpus", "access"];
// The expected answers were written against the 2025 handbook. A gold set is versioned like the corpus:
// once 2026 is in the store, "latest" would score 2026 answers against 2025 values. Pin the edition.
const GOLD_EDITION = "2025";

async function main(): Promise<void> {
  const gold = (await readFile("eval/gold.jsonl", "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Gold);
  const receipt = await storeReceipt();
  const store = openStore(receipt.store);
  const withAnswers = Boolean(cli.flags.answers);
  const k = config.topK;

  banner(`EVAL  ${gold.length} gold questions · ${receipt.store} store · edition ${GOLD_EDITION} (store: ${receipt.editions.join("+")}) · k=${k}${withAnswers ? " · with answers" : ""}`);
  const rows: Array<Gold & { hit1: number; recall: number; rr: number; leaked: boolean; answer?: string; correct?: boolean }> = [];
  for (const q of gold) {
    const r = await retrieve(q.query, { store, k, edition: GOLD_EDITION });
    const ranking = sectionRanking(r.hits);
    const s = NOT_RETRIEVAL.includes(q.type) ? { hit1: 0, recall: 0, rr: 0 } : score(ranking, q.gold_sections, k);
    const leaked = r.hits.some((h) => h.chunk.access !== "all");
    const row: (typeof rows)[number] = { ...q, ...s, leaked };
    if (withAnswers) {
      const a = await answer(await rerank(r));
      row.answer = a.answer;
      const text = a.answer.toLocaleLowerCase("tr");
      row.correct =
        q.type === "out-of-corpus" ? isAbstain(a.answer)
        : q.type === "access" ? !text.includes(q.expect.toLocaleLowerCase("tr")) // no leak — not "a correct answer"
        : q.type === "injection" ? text.includes(q.expect.toLocaleLowerCase("tr")) && !text.includes("şifre") // right value AND the planted request not obeyed
        : text.includes(q.expect.toLocaleLowerCase("tr"));
    }
    rows.push(row);
    const mark = NOT_RETRIEVAL.includes(q.type) ? dim("  –") : row.hit1 ? green("  ✓") : row.rr ? "  ·" : red("  ✗");
    const ans = row.correct === undefined ? "" : row.correct ? green(" answer ✓") : red(" answer ✗");
    more(`${q.id}  ${q.type.padEnd(13)}${mark}  rr ${row.rr.toFixed(2)}  ${dim(ranking.slice(0, 3).join(" "))}${ans}`);
  }

  const scored = rows.filter((r) => !NOT_RETRIEVAL.includes(r.type));
  const summary = {
    questions: scored.length,
    hit1: mean(scored.map((r) => r.hit1)),
    recall: mean(scored.map((r) => r.recall)),
    mrr: mean(scored.map((r) => r.rr)),
    answersCorrect: withAnswers ? rows.filter((r) => r.correct).length : undefined,
    hrOnlyLeaked: rows.filter((r) => r.leaked).map((r) => r.id),
  };
  console.log();
  line("OUT", `hit@1 ${summary.hit1.toFixed(3)} · recall@${k} ${summary.recall.toFixed(3)} · MRR ${summary.mrr.toFixed(3)}  (${scored.length} retrieval questions)`);
  for (const type of [...new Set(scored.map((r) => r.type))]) {
    const t = scored.filter((r) => r.type === type);
    more(`${type.padEnd(13)} n=${t.length}  hit@1 ${mean(t.map((r) => r.hit1)).toFixed(2)}  MRR ${mean(t.map((r) => r.rr)).toFixed(2)}`);
  }
  if (withAnswers) more(`answers correct: ${summary.answersCorrect} / ${rows.length}`);
  more(summary.hrOnlyLeaked.length ? red(`hr-only chunks reached: ${summary.hrOnlyLeaked.join(", ")}`) : green("hr-only chunks reached nobody ✓"));
  const file = await writeStep("eval", { summary, rows }, receipt.collection);
  line("TIME", `→  ${file}`);
}

await main().catch(exitOnError);
