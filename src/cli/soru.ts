// npm run soru
// The day's question through whatever the pipeline can do RIGHT NOW, plus the ledger of every
// answer it gave today. Run it after each step and watch the answer move.
//   nothing built yet      → the bare model answers (step 0)
//   chunks exist (step 3)  → a black box searches them in memory (steps 4–5 are coming)
//   the store is filled    → the real pipeline: store → rerank → answer
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { config } from "../lib/config.js";
import { readStep } from "../lib/data.js";
import { banner, bold, dim, green, line, more, preview, yellow } from "../lib/log.js";
import { embed, generate } from "../lib/ollama.js";
import { JsonStore } from "../lib/store-json.js";
import { openStore, type VectorStore } from "../lib/store.js";
import type { Chunk } from "../lib/types.js";
import { retrieve } from "../steps/6-retrieve.js";
import { rerank } from "../steps/7-rerank.js";
import { answer } from "../steps/8-answer.js";
import { exitOnError } from "./errors.js";

const LEDGER = ".cache/soru-ledger.jsonl";

interface Entry {
  at: string;
  how: string;
  answer: string;
  sources: string[];
}

/** Pick the most complete pipeline the data/ folder supports. */
async function pipeline(): Promise<{ store: VectorStore; how: string } | undefined> {
  let chunks: Chunk[];
  try {
    chunks = (await readStep<Chunk[]>("3-chunks", "2-clean")).data;
  } catch {
    return undefined;
  }
  const chunker = chunks.some((c) => /#c\d/.test(c.id)) ? "fixed" : "section";
  try {
    await readStep("4-vectors", "3-chunks");
    const receipt = (await readStep<{ store: "chroma" | "json" }>("5-store", "4-vectors")).data;
    return { store: openStore(receipt.store), how: `${receipt.store} store · chunker ${chunker}` };
  } catch {
    // no store yet (or it is older than the chunks): search the chunks in memory
    const memory = new JsonStore("data/.soru-memory.json");
    const { vectors } = await embed(chunks.map((c) => c.text));
    await memory.replaceEdition(chunks[0]!.edition, chunks.map((c, i) => ({ ...c, vector: vectors[i]! })));
    return { store: memory, how: `chunker ${chunker} · in-memory search (black box)` };
  }
}

async function main(): Promise<void> {
  banner(`GÜNÜN SORUSU  ${config.dayQuestion}`);
  const p = await pipeline();
  let entry: Entry;
  if (!p) {
    const gen = await generate(config.dayQuestion, { system: "Kısa cevap ver." });
    entry = { at: new Date().toISOString(), how: "bare model, no documents", answer: gen.text, sources: [] };
    line("HOW", entry.how);
    console.log(`\n${yellow(gen.text)}\n`);
  } else {
    const r = await retrieve(config.dayQuestion, { store: p.store });
    const rr = await rerank(r);
    const a = await answer(rr);
    entry = {
      at: new Date().toISOString(),
      how: `${p.how} · rerank ${rr.rerank ? "on" : "off"} · filter ${JSON.stringify(r.filter)}`,
      answer: a.answer,
      sources: a.sources.map((s) => s.id),
    };
    line("HOW", entry.how);
    console.log(`\n${green(a.answer)}\n`);
    a.sources.forEach((s) => more(`[${s.n}] ${s.id}  ${s.where}`));
  }
  await mkdir(".cache", { recursive: true });
  await appendFile(LEDGER, JSON.stringify(entry) + "\n");

  const all = (await readFile(LEDGER, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Entry);
  console.log(`\n   ${bold("LEDGER")} ${dim(`(${LEDGER})`)}`);
  for (const e of all.slice(-12)) {
    more(`${new Date(e.at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}  ${preview(e.answer, 46).padEnd(46)}  ${dim(preview(e.how, 70))}`);
  }
  console.log();
}

await main().catch(exitOnError);
