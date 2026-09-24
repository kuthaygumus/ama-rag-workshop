// npm run step -- <n> ["question"]
// Run ONE step. It reads the previous step's file from data/ and writes its own.
//   npm run step -- 3                    chunk data/2-clean.json → data/3-chunks.json
//   npm run step -- 6 "tatil hakkım?"    retrieve for any question (steps 6–8 default to the day's question)
import { cli } from "../lib/config.js";
import { exitOnError } from "./errors.js";

const [n, question] = cli.positionals;
const steps: Record<string, () => Promise<unknown>> = {
  "0": async () => (await import("../steps/0-bare.js")).run(question),
  "1": async () => (await import("../steps/1-load.js")).run(),
  "2": async () => (await import("../steps/2-clean.js")).run(),
  "3": async () => (await import("../steps/3-chunk.js")).run(),
  "4": async () => (await import("../steps/4-embed.js")).run(),
  "5": async () => (await import("../steps/5-store.js")).run(),
  "6": async () => (await import("../steps/6-retrieve.js")).run(question),
  "7": async () => (await import("../steps/7-rerank.js")).run(),
  "8": async () => (await import("../steps/8-answer.js")).run(),
};

const step = steps[n ?? ""];
if (!step) {
  console.error('usage: npm run step -- <0-8> ["question"]');
  process.exit(1);
}
await step().catch(exitOnError);
