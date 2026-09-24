// STEP 2 — CLEAN
// Gate: extracted text is noisy. The same page header sits on every page, so every chunk would carry
// "Kraken Air | Yıllık İzin Politikası | Sürüm 2025" and look alike to the search. Lines are broken
// where the PDF page ended, so "yıllık ücretli izin" and "24 iş günü" can land on different lines.
//
// Nothing clever here: a few rules and a line-joiner. In real projects this is where most time goes.
import { StaleInputError, readStep, writeStep } from "../lib/data.js";
import { done, dim, line, more, stepHeader } from "../lib/log.js";
import type { CleanDoc, Doc } from "../lib/types.js";
import { corpusHash } from "./1-load.js";

// ── YOUR TURN ───────────────────────────────────────────────────────────────────────────────────
// The English document (it-security) ends every page with "CONFIDENTIAL – Internal use only".
// No rule removes it yet: open data/2-clean.json and find it. Write the rule the way the Turkish
// footer rule below is written, re-run step 2, and check: npm run check:sibling
export const englishFooter: RegExp | undefined = undefined;

// TOGGLE noise rules — comment one out, re-run step 2, and find what it used to remove
const NOISE: RegExp[] = [
  /^Kraken Air \| .+ \| (Sürüm|Edition) \d{4}$/, // default — page header, repeated on every page
  /^GİZLİ – .+$/, // default — Turkish confidentiality footer
  /^Sayfa \d+ \/ \d+$/, // default — Turkish page number
  /^Page \d+ of \d+$/, // default — English page number

  ...(englishFooter ? [englishFooter] : []),
];

/** True for a line that is extraction noise, not content. */
export function isNoise(l: string, rules: RegExp[] = NOISE): boolean {
  return rules.some((re) => re.test(l.trim()));
}

/** Headings, table rows and blank lines are complete on their own — nothing is joined onto them. */
const closed = (l: string) => l.startsWith("#") || l.startsWith("|") || l.trim() === "";
/** Headings, table rows, blank lines and list items always start a new line. */
const opens = (l: string) => closed(l) || /^\s*([-*]|\d+\.)\s/.test(l);

/**
 * Remove noise lines, then re-join prose lines that the page width broke apart.
 * @param body a document body from step 1
 * @returns the clean text and how many noise lines were dropped
 */
export function cleanText(body: string, rules: RegExp[] = NOISE): { text: string; noiseLines: number } {
  const lines = body.split("\n");
  const kept = lines.filter((l) => !isNoise(l, rules));
  const out: string[] = [];
  for (const l of kept) {
    const prev = out[out.length - 1];
    if (prev !== undefined && !closed(prev) && !opens(l)) out[out.length - 1] = `${prev} ${l.trim()}`;
    else out.push(l);
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, noiseLines: lines.length - kept.length };
}

/** Run step 2 on data/1-docs.json and write data/2-clean.json. */
export async function run(): Promise<CleanDoc[]> {
  stepHeader(2, "clean");
  const t0 = performance.now();
  const input = await readStep<Doc[]>("1-docs");
  const edition = input.data[0]?.edition ?? "";
  if (input.inputHash !== (await corpusHash(edition))) {
    throw new StaleInputError(`corpus/${edition}/ changed after step 1 ran. Run it again: npm run step -- 1`);
  }
  line("IN", `data/1-docs.json  (${input.data.length} documents, edition ${edition})`);
  line("WHAT", `drop noise lines (${NOISE.length} rules) · re-join lines the page width broke`);

  const docs: CleanDoc[] = input.data.map(({ path: _path, body, ...meta }) => ({ ...meta, ...cleanText(body) }));

  const before = input.data.reduce((s, d) => s + d.body.split("\n").length, 0);
  const after = docs.reduce((s, d) => s + d.text.split("\n").length, 0);
  line("OUT", `${before} lines → ${after} lines · ${docs.reduce((s, d) => s + d.noiseLines, 0)} noise lines removed`);
  for (const d of docs) more(`${d.id.padEnd(24)} −${String(d.noiseLines).padStart(2)} noise lines`);

  // before/after on the first page of the key document
  const sample = input.data.find((d) => d.id === "hr-leave") ?? input.data[0];
  if (sample) {
    more("");
    more(dim(`before (${sample.id}, first 6 lines):`));
    sample.body.split("\n").slice(0, 6).forEach((l) => more(dim(`  │ ${l}`)));
    more(dim("after:"));
    cleanText(sample.body).text.split("\n").slice(0, 3).forEach((l) => more(`  │ ${l}`));
  }
  const file = await writeStep("2-clean", docs, input.hash);
  done(t0, file);
  return docs;
}
