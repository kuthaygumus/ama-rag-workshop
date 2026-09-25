// npm run capture   (trainer tool — takes ~15 minutes)
// Plays the whole day once, in order, and records every output into logs/<name>.txt. The course site
// shows these files and nothing else: no number on the site is typed by hand.
// It resets data/, the store and the soru ledger, and leaves the store with both editions at the end.
process.env.NO_COLOR = "1";

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { config } from "../lib/config.js";
import { clearData } from "../lib/data.js";
import { generate } from "../lib/ollama.js";
import { openStore } from "../lib/store.js";
import type { Gold } from "./eval.js";

const steps = {
  s0: await import("../steps/0-bare.js"),
  s1: await import("../steps/1-load.js"),
  s2: await import("../steps/2-clean.js"),
  s3: await import("../steps/3-chunk.js"),
  s4: await import("../steps/4-embed.js"),
  s5: await import("../steps/5-store.js"),
  s6: await import("../steps/6-retrieve.js"),
  s7: await import("../steps/7-rerank.js"),
  s8: await import("../steps/8-answer.js"),
};

const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";

/** Record console output of an in-process call. */
async function record(name: string, command: string, fn: () => Promise<unknown>): Promise<void> {
  const out: string[] = [`$ ${command}`];
  const orig = { log: console.log, error: console.error };
  console.log = console.error = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  await save(name, out.join("\n"));
}

/** Record a CLI exactly as a participant would run it. */
async function run(name: string, args: string[]): Promise<void> {
  const res = spawnSync("npx", ["tsx", ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const shown = `npm run ${args[0]!.replace(/^src\/(cli|explore)\/|\.ts$/g, "")}${args.length > 1 ? ` -- ${args.slice(1).map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}` : ""}`;
  await save(name, `$ ${shown}\n${res.stdout}${res.stderr}`);
}

async function save(name: string, text: string): Promise<void> {
  await writeFile(`logs/${name}.txt`, clean(text));
  console.log(`  ✓ logs/${name}.txt`);
}

const gold = (await readFile("eval/gold.jsonl", "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Gold);
const first = (type: string) => gold.find((g) => g.type === type)!.query;
const noRule = (fragment: string) => steps.s8.RULES.filter((r) => !r.includes(fragment));

/** Steps 6 → 7 → 8 with explicit settings, printed like the real steps. */
async function pipeline(question: string, o: { access?: string[] | undefined; edition?: "latest" | "all"; rules?: string[]; rerank?: boolean } = {}) {
  const store = openStore();
  const r = await steps.s6.retrieve(question, { store, ...("access" in o ? { access: o.access } : {}), ...(o.edition ? { edition: o.edition } : {}) });
  console.log(`   filter ${JSON.stringify(r.filter)}`);
  steps.s6.printRanked(r);
  const rr = await steps.s7.rerank(r, o.rerank ?? true);
  const a = await steps.s8.answer(rr, o.rules);
  steps.s8.printAnswer(a, false);
}

await mkdir("logs", { recursive: true });
await rm(".cache/soru-ledger.jsonl", { force: true });
await clearData();
await openStore().reset();
console.log("capture: playing the day …");

// Başlamadan
await run("doctor", ["src/cli/doctor.ts"]);
await record("00-bare", "npm run step -- 0", () => steps.s0.run());
await run("soru-0-bare", ["src/cli/soru.ts"]);

// A · raw data + clean
await record("01-load", "npm run step -- 1", () => steps.s1.run());
await record("02-clean", "npm run step -- 2", () => steps.s2.run());

// B · chunking: fixed first, then by section
await record("03-chunk-fixed", "npm run step -- 3   (chunker: fixed)", () => steps.s3.run("fixed"));
await run("soru-1-fixed", ["src/cli/soru.ts"]);
await record("03-chunk-section", "npm run step -- 3   (chunker: section)", () => steps.s3.run("section"));
await run("soru-2-section", ["src/cli/soru.ts"]);

// C · embedding + "what do we have?"
await record("04-embed", "npm run step -- 4", () => steps.s4.run());
await run("04b-similar", ["src/explore/similar.ts"]);
await run("04b-map", ["src/explore/map.ts"]);
await copyFile("data/map.json", "logs/map.json");

// D · vector DB
await record("05-store-json", "npm run step -- 5 --store json", () => steps.s5.run("json"));
await record("05-store-chroma", "npm run step -- 5", () => steps.s5.run("chroma"));

// E · retrieval + rerank
await record("06-retrieve", "npm run step -- 6", () => steps.s6.run());
await record("07-rerank-off", "npm run step -- 7   (RERANK = false)", () => steps.s7.run(false));
await record("08-answer-rerank-off", "npm run step -- 8   (after rerank off)", () => steps.s8.run());
await record("07-rerank", "npm run step -- 7", () => steps.s7.run(true));
await run("08-answer", ["src/cli/step.ts", "8", "--prompt"]);
await run("soru-3-full", ["src/cli/soru.ts"]);

// E / Güvenlik · access filter
await run("ask-access-on", ["src/cli/ask.ts", first("access")]);
await record("ask-access-off", `npm run ask -- "${first("access")}"   (ASKER_MAY_READ = undefined)`, () => pipeline(first("access"), { access: undefined }));

// F · answer generation: abstain + injection
await run("ask-out-of-corpus", ["src/cli/ask.ts", first("out-of-corpus")]);
await record("ask-out-of-corpus-rule-off", `npm run ask -- "${first("out-of-corpus")}"   (abstain rule commented out)`, () => pipeline(first("out-of-corpus"), { rules: noRule("yoksa yalnızca") }));
await run("ask-injection", ["src/cli/ask.ts", first("injection")]);
await record("ask-injection-rule-off", `npm run ask -- "${first("injection")}"   (the concrete-ban rule commented out)`, () => pipeline(first("injection"), { rules: noRule("asla şifre") }));

// 4 · quality: section vs fixed, then answers
await run("eval-section", ["src/cli/eval.ts"]);
await run("eval-answers", ["src/cli/eval.ts", "--answers"]);
await record("ingest-fixed", "npm run step -- 3 / 4 / 5   (chunker: fixed)", async () => {
  await steps.s3.run("fixed");
  await steps.s4.run();
  await steps.s5.run("chroma");
});
await run("eval-fixed", ["src/cli/eval.ts"]);
await record("ingest-section", "npm run step -- 3 / 4 / 5   (chunker: section)", async () => {
  await steps.s3.run("section");
  await steps.s4.run();
  await steps.s5.run("chroma");
});

// 4 · performance and cost: stuff the whole handbook into the prompt
await record("stuff-everything", "every document in one prompt (no retrieval)", async () => {
  const docs = JSON.parse(await readFile("data/2-clean.json", "utf8")).data as { id: string; text: string }[];
  const all = docs.map((d) => `### ${d.id}\n${d.text}`).join("\n\n");
  const g = await generate(`KAYNAKLAR:\n\n${all}\n\nSORU: ${config.dayQuestion}\nCEVAP:`, { system: steps.s8.system(), numCtx: 32768 });
  console.log(`   documents      ${docs.length} (${all.length} characters)`);
  console.log(`   prompt tokens  ${g.promptTokens}`);
  console.log(`   time           ${g.ms} ms`);
  console.log(`\n${g.text}`);
});

// Veri değişince · the 2026 edition
await run("ingest-2026", ["src/cli/ingest.ts", "--edition", "2026"]);
await run("soru-4-2026", ["src/cli/soru.ts"]);
await record("edition-all", `npm run soru   (EDITION_FILTER = "all")`, () => pipeline(config.dayQuestion, { edition: "all" }));

console.log("capture: done — now in the site repo: npm run sync");
