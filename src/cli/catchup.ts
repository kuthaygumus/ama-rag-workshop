// npm run catchup -- <n>
// Lost? This puts you exactly where the room is after step n — without touching the code you wrote.
//   1. every TOGGLE block goes back to its default line (the one marked "// default")
//   2. data/ is emptied and the store is reset
//   3. steps 1..n run again
// Your own functions (the YOUR TURN exercises) are left as they are.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli } from "../lib/config.js";
import { clearData } from "../lib/data.js";
import { banner, more } from "../lib/log.js";
import { openStore } from "../lib/store.js";
import { resetToggles } from "../lib/toggles.js";
import { exitOnError } from "./errors.js";

async function main(): Promise<void> {
  const n = Number(cli.positionals[0]);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    console.error("usage: npm run catchup -- <1-8>   (the step the room just finished)");
    process.exit(1);
  }
  banner(`CATCH-UP to step ${n}`);
  for (const f of (await readdir("src/steps")).filter((x) => x.endsWith(".ts"))) {
    const path = join("src/steps", f);
    const { source, changed } = resetToggles(await readFile(path, "utf8"));
    if (changed) {
      await writeFile(path, source);
      more(`toggles reset: ${path} (${changed} line${changed > 1 ? "s" : ""})`);
    }
  }
  await clearData();
  more("data/ emptied");
  if (n >= 5) {
    await openStore().reset();
    more("store reset");
  }
  // imported only now, so the steps read the toggles we just reset
  const steps = [
    () => import("../steps/1-load.js").then((m) => m.run()),
    () => import("../steps/2-clean.js").then((m) => m.run()),
    () => import("../steps/3-chunk.js").then((m) => m.run()),
    () => import("../steps/4-embed.js").then((m) => m.run()),
    () => import("../steps/5-store.js").then((m) => m.run()),
    () => import("../steps/6-retrieve.js").then((m) => m.run()),
    () => import("../steps/7-rerank.js").then((m) => m.run()),
    () => import("../steps/8-answer.js").then((m) => m.run()),
  ];
  for (const step of steps.slice(0, n)) await step();
  console.log(`\nYou are at step ${n}, same as the room.\n`);
}

await main().catch(exitOnError);
