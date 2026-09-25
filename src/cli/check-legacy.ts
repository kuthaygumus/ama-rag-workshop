// npm run check:legacy [-- <dir>]
// Guard: nothing from the retired course material may come back. Fails on any marker below, in any
// file of this repo (or of <dir>, e.g. a build output).
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { cli } from "../lib/config.js";

const MARKERS: RegExp[] = [
  /ama-rag-(course|from-scratch|lab)\b/,
  /amadeus/i,
  /fare_classic/i,
  /CLASSIC K\b/,
  /kraken-q2/i,
  /\bMNIST\b/i,
  /\bColab\b/i,
  /\.ipynb\b/,
  /\.py\b/,
  /going-further/,
  /presenter/i,
  /\bHelios\b/i,
  /\bIRIS\b/,
  /\blab\b/i,
  /npm run soru\b|soru\.ts\b|soru-ledger/, // renamed to question on 25 Sep 2026
];
const SKIP = new Set(["node_modules", ".git", "data", ".cache", ".astro"]);
const TEXT = /\.(ts|js|mjs|cjs|json|jsonl|md|mdx|astro|css|html|svg|yaml|yml|bru|txt|env|example)$|^\.[a-z]+$/;
const SELF = /check-legacy\.(ts|mjs)$/;

async function* files(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (TEXT.test(e.name) && !SELF.test(p) && e.name !== "package-lock.json") yield p;
  }
}

const root = cli.positionals[0] ?? ".";
let hits = 0;
let scanned = 0;
for await (const f of files(root)) {
  scanned++;
  (await readFile(f, "utf8")).split("\n").forEach((l, i) => {
    for (const m of MARKERS) {
      if (m.test(l)) {
        hits++;
        console.log(`${relative(".", f)}:${i + 1}  ${m}  ${l.trim().slice(0, 100)}`);
      }
    }
  });
}
console.log(hits ? `\ncheck:legacy ✗ ${hits} hit(s) in ${scanned} files` : `check:legacy ✓ 0 hits in ${scanned} files`);
process.exit(hits ? 1 : 0);
