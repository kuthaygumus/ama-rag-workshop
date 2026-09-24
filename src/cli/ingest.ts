// npm run ingest [-- --edition 2026] [--store json] [--reset]
// The offline half, steps 1–5 in one go: load → clean → chunk → embed → store.
// Runs once, or whenever the documents change. No chat model involved.
//   --edition 2026   read corpus/2026/ (added next to the editions already stored)
//   --reset          empty the store first
import { cli, config } from "../lib/config.js";
import { openStore } from "../lib/store.js";
import { run as load } from "../steps/1-load.js";
import { run as clean } from "../steps/2-clean.js";
import { run as chunk } from "../steps/3-chunk.js";
import { run as embed } from "../steps/4-embed.js";
import { run as store } from "../steps/5-store.js";
import { exitOnError } from "./errors.js";

try {
  if (cli.flags.reset) await openStore().reset();
  await load();
  await clean();
  await chunk();
  await embed();
  await store();
  console.log(`\nIngest done (edition ${config.edition}). Now: npm run soru\n`);
} catch (e) {
  exitOnError(e);
}
