// npm run check:story [-- --offline | --all | --write-facts]   (course-maintenance tool)
// Proves the day's story on the captured logs: every claim the course pages make about a log, the corpus or
// the code is one assertion here. Run it after every change to corpus/, eval/, the prompts or logs/.
//
//   layers   K = corpus (imports steps 1-3, no Ollama)   T = static (source, gold, npm scripts)   L = logs/
//   tiers    1 = structure the story needs (fix the data)   2 = a narrated model outcome (retune or re-narrate)
//            3 = environment (timings, warm cache): WARN only
//   classes  N = language-neutral   P = parameterised from source, gold or corpus   E = English data only
//            (PEND while the corpus is not English)
//   flags    --offline      K and T only (no logs needed; about a second)
//            --all          also runs npm test and both check:sibling runs (T06)
//            --write-facts  also writes <logs>/facts.json: every number the pages quote, with its source log
//   env      LOGS_DIR, CORPUS_DIR, GOLD_FILE, SITE_DIR override the inputs (used by the negative controls)
//   exit     1 = a tier-1 FAIL · 2 = only tier-2 FAILs · 0 = otherwise (WARN and PEND never fail)
//   logs     every log in REQUIRED_LOGS must exist: a missing one is a tier-1 FAIL of each id that reads it (and L00),
//            never PEND. Only NOT_CAPTURED_YET may be PEND for "no log yet".
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../lib/config.js";
import { preview } from "../lib/log.js";
import { score } from "../lib/metrics.js";
import type { Chunk, CleanDoc } from "../lib/types.js";
import { parseFrontMatter } from "../steps/1-load.js";
import { cleanText } from "../steps/2-clean.js";
import { bySection, fixedSize } from "../steps/3-chunk.js";
import type { Ranked } from "../steps/7-rerank.js";
import { ABSTAIN, RULES, buildPrompt, isAbstain } from "../steps/8-answer.js";
import type { Gold } from "./eval.js";

const { values: opts } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: { offline: { type: "boolean" }, all: { type: "boolean" }, "write-facts": { type: "boolean" } },
});
const OFFLINE = opts.offline === true;
const ALL = opts.all === true;
const WRITE_FACTS = opts["write-facts"] === true;

const LOGS = resolve(process.env.LOGS_DIR ?? "logs");
const CORPUS = resolve(process.env.CORPUS_DIR ?? "corpus");
const GOLD_FILE = resolve(process.env.GOLD_FILE ?? "eval/gold.jsonl");
const SITE = resolve(process.env.SITE_DIR ?? "../ama-rag-site");

// ── harness ─────────────────────────────────────────────────────────────────────────────────────

type Tier = 1 | 2 | 3;
type Cls = "N" | "P" | "E";
type Status = "PASS" | "FAIL" | "WARN" | "PEND";
interface Spec {
  id: string;
  tier: Tier;
  cls: Cls;
  /** contract beats this assertion proves */
  sids: string;
  /** logs it reads: missing ones make it PEND */
  logs?: string[];
  /** a sub-check of the id, printed in front of the detail */
  part?: string;
  /** a failure only WARNs (the page copies whatever the log says) */
  soft?: boolean;
  /** runs with --all only */
  needsAll?: boolean;
}
type Outcome = boolean | { ok: boolean; detail?: string };
/** hard: a FAIL that counts as tier 1 whatever the spec's tier (a required log is missing). */
const ROWS: { spec: Spec; status: Status; detail: string; hard?: boolean }[] = [];

/** Fail loudly when a value the story needs is absent. */
function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`not found: ${what}`);
  return v;
}

const logPath = (n: string) => join(LOGS, n.endsWith(".json") ? n : `${n}.txt`);
const hasLog = (n: string) => existsSync(logPath(n));

/** Every log capture writes today. A missing one means a failed or partial recapture: FAIL, not PEND. */
const REQUIRED_LOGS = [
  "doctor", "00-bare", "question-0-bare", "01-load", "02-clean", "03-chunk-fixed", "question-1-fixed", "03-chunk-section",
  "question-2-section", "04-embed", "04b-similar", "04b-map", "map.json", "05-store-json", "05-store-chroma", "06-retrieve",
  "07-rerank-off", "08-answer-rerank-off", "07-rerank", "08-answer", "question-3-full", "ask-access-on", "ask-access-off",
  "ask-out-of-corpus", "ask-out-of-corpus-rule-off", "ask-injection", "ask-injection-rule-off", "eval-section", "eval-answers",
  "ingest-fixed", "eval-fixed", "ingest-section", "ingest-2026", "question-4-2026", "edition-all", "stuff-everything",
];
/** Logs capture.ts writes but no capture has recorded yet (P4 captures them; move them to REQUIRED_LOGS then).
 *  Only these may be PEND for "no log yet". */
const NOT_CAPTURED_YET = ["ask-paraphrase", "eval-section-json", "eval-fixed-json", "ask-2026-password"];
/** Every log name a spec declared: L00 proves each one is in one of the two lists above. */
const DECLARED = new Set<string>();

/** One assertion. Its status follows from the spec (class E, missing logs) or from fn. */
function A(spec: Spec, fn: () => Outcome): void {
  if (OFFLINE && spec.id.startsWith("L")) return;
  for (const n of spec.logs ?? []) DECLARED.add(n);
  const missing = (spec.logs ?? []).filter((n) => !hasLog(n));
  const lost = OFFLINE ? [] : missing.filter((n) => !NOT_CAPTURED_YET.includes(n));
  let status: Status;
  let detail = "";
  let hard = false;
  if (lost.length) {
    status = "FAIL";
    hard = true;
    detail = existsSync(LOGS) ? `required log missing: ${lost.join(", ")}` : `logs directory missing: ${LOGS}`;
  } else if (spec.cls === "E" && DATA_LANG !== "en") {
    status = "PEND";
    detail = `English data only (corpus language today: ${DATA_LANG})`;
  } else if (OFFLINE && missing.length < (spec.logs ?? []).length) {
    status = "PEND";
    detail = "reads logs: not in --offline";
  } else if (missing.length) {
    status = "PEND";
    detail = `no log yet: ${missing.join(", ")}`;
  } else if (spec.needsAll && !ALL) {
    status = "PEND";
    detail = "runs with --all";
  } else {
    let ok = false;
    try {
      const r = fn();
      ok = r === true || (typeof r === "object" && r.ok);
      detail = typeof r === "object" ? (r.detail ?? "") : "";
    } catch (e) {
      detail = `error: ${(e as Error).message}`;
    }
    status = ok ? "PASS" : spec.soft || spec.tier === 3 ? "WARN" : "FAIL";
  }
  ROWS.push({ spec, status, detail: spec.part ? `[${spec.part}] ${detail}` : detail, hard });
}

/** Shorthand for an outcome with a detail. */
const out = (ok: boolean, detail = ""): Outcome => ({ ok, detail });

// ── facts: every number the pages quote, with the log it came from ─────────────────────────────

const FACTS: Record<string, Record<string, { value: unknown; from: string }>> = {};
function fact(key: string, value: unknown, from: string): void {
  const [group = "misc", ...rest] = key.split(".");
  (FACTS[group] ??= {})[rest.join(".") || "value"] = { value, from };
}

// ── inputs: gold, source constants, the corpus replica of steps 1-3 ────────────────────────────

const read = (p: string) => readFileSync(p, "utf8");
const gold: Gold[] = read(GOLD_FILE).trim().split("\n").map((l) => JSON.parse(l) as Gold);
const G = (id: string) => must(gold.find((g) => g.id === id), `gold ${id}`);
/** The query of the first gold row of a type: what capture asks (capture.ts `first(type)`). */
const firstOf = (type: string) => must(gold.find((g) => g.type === type), `gold type ${type}`);

/** Regex literals of a `const NAME: RegExp[] = [ … ];` block, read from source (the array is not exported). */
function regexBlock(src: string, name: string): RegExp[] {
  const i = src.indexOf(`const ${name}`);
  const block = src.slice(i, src.indexOf("\n];", i));
  return [...block.matchAll(/^\s*\/(.+)\/([a-z]*),/gm)].map((m) => new RegExp(m[1]!, m[2]));
}
const SRC_CLEAN = read("src/steps/2-clean.ts");
const NOISE = regexBlock(SRC_CLEAN, "NOISE");
const HEADER_RULE = must(NOISE[0], "NOISE[0] (page header)");
/** Page-number rules: the noise rules after the first that count something. */
const PAGE_RULES = NOISE.slice(1).filter((r) => r.source.includes("\\d+"));

/** The homework solution of step 2: the one regex exported by solutions/*-confidential.ts. */
const SOLUTION_FILE = must(readdirSync("solutions").find((f) => /-confidential\.ts$/.test(f)), "solutions/*-confidential.ts");
const SOLUTION = must(
  Object.values((await import(resolve("solutions", SOLUTION_FILE))) as Record<string, unknown>).find((v) => v instanceof RegExp) as RegExp | undefined,
  `a RegExp export in solutions/${SOLUTION_FILE}`,
);

/** Capture's rule-off fragments, in capture order (importing capture.ts would run the capture). */
const SRC_CAPTURE = read("src/cli/capture.ts");
const FRAGMENTS = [...SRC_CAPTURE.matchAll(/noRule\("([^"]+)"\)/g)].map((m) => m[1]!);
/** The marker capture prints at the end of a rule-off log's line 1, e.g. "(abstain rule commented out)", by log name. */
const RULE_OFF_MARKER: Record<string, string> = Object.fromEntries(
  [...SRC_CAPTURE.matchAll(/record\("([\w-]+-rule-off)", `[^`\n]*?\s{2,}(\([^`\n]+\))`/g)].map((m) => [m[1]!, m[2]!]),
);

/** The banner word(s) question.ts prints before the day's question. */
const BANNER = must(read("src/cli/question.ts").match(/banner\(`([^`$]+?)\s*\$\{config\.dayQuestion\}`\)/)?.[1], "question.ts banner");

/** The fence lines buildPrompt wraps around each source, as patterns (number and title vary). */
const FENCE = (() => {
  const fake = [{ chunk: { title: "TTITLE", text: "XBODYX" } }] as unknown as Ranked[];
  const ls = buildPrompt("Q", fake).split("\n");
  const at = ls.indexOf("XBODYX");
  const pat = (l: string) => new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("1", "\\d").replace("TTITLE", ".+")}$`);
  return { open: pat(must(ls[at - 1], "fence open")), close: pat(must(ls[at + 1], "fence close")) };
})();

interface RDoc extends CleanDoc {
  file: string;
  body: string;
  rawLines: number;
  afterLines: number;
}
const editionFiles = (ed: string) => readdirSync(join(CORPUS, ed)).filter((n) => n.endsWith(".md")).sort();
const rawOf = (ed: string, file: string) => read(join(CORPUS, ed, file)).replace(/\r\n/g, "\n");
const DOCS = new Map<string, RDoc[]>();
/** Steps 1-2 on corpus/<ed>, with the imported parser and cleaner (rules: an alternative NOISE list). */
function docsOf(ed: string, rules?: RegExp[]): RDoc[] {
  const key = rules ? "" : ed;
  if (key && DOCS.has(key)) return DOCS.get(key)!;
  const docs = editionFiles(ed).map((file) => {
    const { meta, body } = parseFrontMatter(rawOf(ed, file));
    const c = rules ? cleanText(body, rules) : cleanText(body);
    return { ...(meta as unknown as CleanDoc), file, body, text: c.text, noiseLines: c.noiseLines, rawLines: body.split("\n").length, afterLines: c.text.split("\n").length };
  });
  if (key) DOCS.set(key, docs);
  return docs;
}
const doc = (ed: string, id: string) => must(docsOf(ed).find((d) => d.id === id), `doc ${id}@${ed}`);
const sectionChunks = (ed: string, rules?: RegExp[]) => docsOf(ed, rules).flatMap((d) => bySection(d));
const fixedChunks = (ed: string) => docsOf(ed).flatMap((d) => fixedSize(d, 300));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The corpus language: the lang 7 of the 8 docs share. The odd doc is the one that differs. */
const LANGS = docsOf("2025").map((d) => d.lang);
const DATA_LANG = must(LANGS.find((l) => LANGS.filter((x) => x === l).length > 1), "majority lang");
const ODD = must(docsOf("2025").find((d) => d.lang !== DATA_LANG), "odd-language doc");
/** Pages of a doc = page-header lines in its raw body. */
const pagesOf = (d: RDoc) => d.body.split("\n").filter((l) => HEADER_RULE.test(l.trim())).length;
/** The raw line right under each page header (the confidentiality line). */
const underHeader = (d: RDoc) => {
  const ls = d.body.split("\n");
  return ls.flatMap((l, i) => (HEADER_RULE.test(l.trim()) && ls[i + 1]?.trim() ? [ls[i + 1]!.trim()] : []));
};
/** "| n | v |" → v, in any text. */
const row = (txt: string, n: string | number) => new RegExp(`^\\| ${n} \\| (\\d+) \\|`, "m").exec(txt)?.[1];
/** The text of section n of a clean doc, heading line included. */
const sectionText = (d: RDoc, n: string) => must(d.text.split(/\n(?=## \d+\.)/).find((p) => p.startsWith(`## ${n}.`)), `${d.id} section ${n}`);

// ── log parsers: code-printed English markers only, so they survive the data switch ────────────

const LOGC = new Map<string, string[]>();
/** A log's lines, final newline removed. */
function L(n: string): string[] {
  if (!LOGC.has(n)) LOGC.set(n, read(logPath(n)).replace(/\n$/, "").split("\n"));
  return LOGC.get(n)!;
}
const TXT = (n: string) => L(n).join("\n");
/** Line i of a log, counted from 1 as an editor shows it. */
const ln = (n: string, i: number) => L(n)[i - 1] ?? "";
/** First capture group of re in a log, as a number. */
const num = (n: string, re: RegExp) => Number(must(TXT(n).match(re)?.[1], `${re} in ${n}`));

const RE_HIT = /^\s+(\d+)\s+(\d\.\d{3})\s+(\S+@\d{4}#\S+)/;
const RE_RR = /^\s+(\d+)\s+(?:([▲▼])\s+)?was\s+(\d+)\s+(?:rel\s+(\d+)\s+)?vec\s+(\d\.\d{3})\s+(\S+@\d{4}#\S+)/;
const RE_SRC = /^\s+\[(\d)\] (\S+@\d{4}#\S+)/;
const ID = /\S+@\d{4}#\S+/;

/** Step-6 rows (the 5 above the cut, then the rows below it). */
const hits = (n: string) =>
  L(n).flatMap((l) => {
    const m = l.match(RE_HIT);
    return m ? [{ rank: +m[1]!, score: +m[2]!, id: m[3]! }] : [];
  });
/** Step-7 rows. */
const rr = (n: string) =>
  L(n).flatMap((l) => {
    const m = l.match(RE_RR);
    return m ? [{ pos: +m[1]!, move: m[2] ?? "", was: +m[3]!, rel: m[4] === undefined ? undefined : +m[4], vec: +m[5]!, id: m[6]! }] : [];
  });
/** The `[n] id` source lines under an answer. */
const sources = (n: string) => L(n).flatMap((l) => (l.match(RE_SRC)?.[2] ? [l.match(RE_SRC)![2]!] : []));
/** The metadata filter a log printed. */
function filterOf(n: string): { edition?: string; access?: string[] } {
  const l = must(L(n).find((x) => /filter \{/.test(x)), `filter line in ${n}`);
  return JSON.parse(must(l.match(/filter (\{.*?\})(?: ·|$)/)?.[1], `filter json in ${n}`));
}
/** The answer: the paragraph just above the first `[1] id` line. */
function answer(n: string): string {
  const ls = L(n);
  let j = ls.findIndex((l) => /^\s+\[1\] \S+@\d{4}#\S+/.test(l)) - 1;
  if (j < 0) throw new Error(`no [1] source line in ${n}`);
  while (j >= 0 && !ls[j]!.trim()) j--;
  const lines: string[] = [];
  while (j >= 0 && ls[j]!.trim()) lines.unshift(ls[j--]!);
  return lines.join(" ").trim();
}
/** Step 0's answer: the block after OUT, before TIME. */
function bareAnswer(n: string): string {
  const ls = L(n);
  let j = ls.findIndex((l) => /^\s+OUT /.test(l)) + 1;
  while (j < ls.length && !ls[j]!.trim()) j++;
  const lines: string[] = [];
  while (j < ls.length && ls[j]!.trim() && !/^\s+TIME/.test(ls[j]!)) lines.push(ls[j++]!);
  return lines.join(" ");
}
/** stuff-everything's answer: everything after the first blank line. */
const stuffAnswer = () => L("stuff-everything").slice(L("stuff-everything").indexOf("") + 1).join(" ").trim();
const evalSummary = (n: string) => {
  const m = must(TXT(n).match(/hit@1 ([\d.]+) · recall@5 ([\d.]+) · MRR ([\d.]+)\s+\((\d+) retrieval questions\)/), `eval summary in ${n}`);
  return { hit1: +m[1]!, recall: +m[2]!, mrr: +m[3]!, n: +m[4]!, line: must(L(n).find((l) => /^\s+OUT\s+hit@1/.test(l)), "OUT").trim() };
};
const evalRows = (n: string) =>
  L(n).flatMap((l) => {
    const m = l.match(/^\s+(q\d\d)\s+(\S+)\s+(✓|✗|·|–)\s+rr ([\d.]+)\s+(.*?)(?:\s+answer (✓|✗))?$/);
    return m ? [{ id: m[1]!, type: m[2]!, mark: m[3]!, rr: +m[4]!, top3: m[5]!.trim(), ans: m[6] }] : [];
  });
const perType = (n: string) =>
  Object.fromEntries(
    L(n).flatMap((l) => {
      const m = l.match(/^\s+([\w-]+)\s+n=(\d+)\s+hit@1 ([\d.]+)\s+MRR ([\d.]+)/);
      return m ? [[m[1]!, { n: +m[2]!, hit1: +m[3]!, mrr: +m[4]! }] as const] : [];
    }),
  ) as Record<string, { n: number; hit1: number; mrr: number }>;
/** The `the chunk holding "| 7 |" → id` block of a chunk log: the id and the box lines. */
function chunkBlock(n: string): { id: string; sections: string; body: string[] } {
  const ls = L(n);
  const i = ls.findIndex((l) => /the chunk holding/.test(l));
  const m = must(ls[i]?.match(/→ (\S+)\s+\(sections ([^)]+)\)/), `chunk block in ${n}`);
  const body: string[] = [];
  for (let j = i + 1; j < ls.length && /^\s+│/.test(ls[j]!); j++) body.push(ls[j]!.replace(/^\s+│ ?/, ""));
  return { id: m[1]!, sections: m[2]!, body };
}
/** A table header line: two cells, neither a number nor dashes. */
const isHeaderRow = (l: string) => {
  const c = l.split("|").map((x) => x.trim()).filter((x) => x !== "");
  return l.trim().startsWith("|") && c.length === 2 && !/^\d/.test(c[0]!) && !/^\d/.test(c[1]!) && !/^-+$/.test(c[0]!);
};
/** TIME value of a log's last TIME line. */
const timeMs = (n: string) => Number(must([...TXT(n).matchAll(/TIME\s+(\d+) ms/g)].pop()?.[1], `TIME in ${n}`));
const has22 = (s: string) => new RegExp(`\\b${G("q01").expect}\\b`).test(s);

// ═══ K · corpus layer ═══════════════════════════════════════════════════════════════════════════

const D25 = docsOf("2025");
const SEC25 = sectionChunks("2025");
const FIX25 = fixedChunks("2025");
const KEYS = [...must(read("src/steps/1-load.ts").match(/const KEYS[^=]*= \[([^\]]+)\]/)?.[1], "KEYS").matchAll(/"(\w+)"/g)].map((m) => m[1]!);
const outCounts = (n: string) => {
  const m = must(TXT(n).match(/(\d+) chunks · avg (\d+) chars · min (\d+) · max (\d+)/), `chunk OUT in ${n}`);
  return { count: +m[1]!, avg: +m[2]!, min: +m[3]!, max: +m[4]! };
};
fact("clean.linesBefore", sum(D25.map((d) => d.rawLines)), "corpus replica");
fact("clean.linesAfter", sum(D25.map((d) => d.afterLines)), "corpus replica");
fact("clean.noise", Object.fromEntries(D25.map((d) => [d.id, d.noiseLines])), "corpus replica");
fact("clean.pages", Object.fromEntries(D25.map((d) => [d.id, pagesOf(d)])), "corpus replica");

A({ id: "K01", tier: 1, cls: "N", sids: "S2.07 S3.10 S3.37", logs: ["02-clean", "03-chunk-fixed", "03-chunk-section"] }, () => {
  const noise = sum(D25.map((d) => d.noiseLines));
  const before = sum(D25.map((d) => d.rawLines));
  const after = sum(D25.map((d) => d.afterLines));
  const m = must(TXT("02-clean").match(/(\d+) lines → (\d+) lines · (\d+) noise lines removed/), "02-clean OUT");
  const f = outCounts("03-chunk-fixed").count;
  const s = outCounts("03-chunk-section").count;
  return out(
    +m[1]! === before && +m[2]! === after && +m[3]! === noise && f === FIX25.length && s === SEC25.length,
    `replica ${before}→${after} lines, ${noise} noise, ${FIX25.length} fixed, ${SEC25.length} section · logs ${m[1]}→${m[2]}, ${m[3]}, ${f}, ${s}`,
  );
});

A({ id: "K02", tier: 1, cls: "P", sids: "S2.10 S2.12 S6.65" }, () => {
  const othersClean = D25.filter((d) => d.id !== ODD.id).every((d) => {
    const lines = new Set(d.text.split("\n").map((l) => l.trim()));
    return underHeader(d).every((u) => !lines.has(u));
  });
  const left = [...new Set(underHeader(ODD))];
  const leftover = must(left[0], "line under the odd doc's page header");
  const kept = ODD.text.split("\n").filter((l) => l.startsWith(leftover)).length;
  const chars = [String.fromCodePoint(0x2013), ...(ODD.lang === "tr" ? [String.fromCodePoint(0x130)] : [])]; // en dash, capital dotted I
  const ok = othersClean && left.length === 1 && kept === pagesOf(ODD) && chars.every((c) => leftover.includes(c) && SOLUTION.source.includes(c));
  fact("clean.leftover", { doc: ODD.id, line: leftover, kept }, "corpus replica");
  return out(ok, `${ODD.id}: "${leftover}" kept ${kept}x, pages ${pagesOf(ODD)}; other docs clean ${othersClean}; solution ${SOLUTION_FILE}`);
});

A({ id: "K03", tier: 1, cls: "P", sids: "S2.06 S2.11 S3.37 S4.42" }, () => {
  const withSol = [...NOISE, SOLUTION];
  const d1 = docsOf("2025", withSol);
  const dNoise = sum(d1.map((d) => d.noiseLines)) - sum(D25.map((d) => d.noiseLines));
  const s1 = sectionChunks("2025", withSol);
  const store0 = SEC25.length + sectionChunks("2026").length;
  const store1 = s1.length + sectionChunks("2026", withSol).length;
  const zero = `${ODD.id}@2025#0`;
  const hw = { noise: dNoise, lines: sum(d1.map((d) => d.afterLines)) - sum(D25.map((d) => d.afterLines)), sectionChunks: s1.length - SEC25.length, storeRecords: store1 - store0 };
  fact("clean.homework", hw, "corpus replica");
  const hl = must(docsOf("2025", NOISE.slice(1)).find((d) => d.id === "hr-leave"), "hr-leave");
  const header = must(doc("2025", "hr-leave").body.split("\n").find((l) => HEADER_RULE.test(l.trim())), "hr-leave header");
  const headerOff = hl.noiseLines === 2 * pagesOf(doc("2025", "hr-leave")) && hl.text.includes(header.trim());
  fact("clean.hrLeaveNoiseRule1Off", hl.noiseLines, "corpus replica (NOISE without its first rule)");
  return out(
    dNoise === pagesOf(ODD) && hw.sectionChunks === -1 && SEC25.some((c) => c.id === zero) && !s1.some((c) => c.id === zero) && hw.storeRecords === -2 && headerOff,
    `homework ${JSON.stringify(hw)}; header rule off: hr-leave noise ${hl.noiseLines}, header kept ${headerOff}`,
  );
});

for (const [part, cls] of [["structure", "P"], ["english", "E"]] as const) {
  A({ id: "K04", part, tier: 1, cls, sids: "S1.39 S1.46 S2.15 S3.28 S3.38 S4.13 S5.01 S5.02 S7.04 S7.25" }, () => {
    if (cls === "E") return out(doc("2025", "hr-leave").lang === "en" && ODD.lang === "tr", `hr-leave ${doc("2025", "hr-leave").lang}, ${ODD.id} ${ODD.lang}`);
    const f25 = editionFiles("2025");
    const f26 = editionFiles("2026");
    const keysOk = ["2025", "2026"].every((ed) =>
      editionFiles(ed).every((f) => {
        const raw = rawOf(ed, f);
        const { meta } = parseFrontMatter(raw);
        return KEYS.length === 6 && KEYS.every((k) => !!meta[k]) && /^edition: "\d{4}"$/m.test(raw) && meta.id === f.replace(/\.md$/, "");
      }),
    );
    const hrOnly = ["2025", "2026"].map((ed) => docsOf(ed).filter((d) => d.access === "hr-only").map((d) => d.id).join());
    const odd26 = docsOf("2026").filter((d) => d.lang !== DATA_LANG).map((d) => d.id).join();
    const ok = f25.length === 8 && f25.join() === f26.join() && keysOk && hrOnly.every((x) => x === "hr-salary-bands") && ODD.id === "it-security" && odd26 === "it-security" && LANGS.filter((l) => l === DATA_LANG).length === 7 && doc("2025", "hr-leave").access === "all";
    return out(ok, `files ${f25.length}/${f26.length}, keys ${keysOk}, hr-only ${hrOnly}, odd ${ODD.id} (${ODD.lang}) / ${odd26}, data ${DATA_LANG}`);
  });
}

A({ id: "K05", tier: 1, cls: "N", sids: "S2.04 S2.05 S2.08" }, () => {
  const hl = doc("2025", "hr-leave");
  const raw = hl.body.split("\n");
  const pages = pagesOf(hl);
  const pageNums = raw.filter((l) => PAGE_RULES.some((r) => r.test(l.trim()))).length;
  const h3 = raw.findIndex((l) => /^## 3\./.test(l));
  const lead3 = raw.slice(h3 + 1, raw.findIndex((l, i) => i > h3 && l.startsWith("|"))).filter((l) => l.trim()).length;
  const leadLines = (n: string) => {
    const ls = sectionText(hl, n).split("\n").slice(1);
    const first = ls.findIndex((l) => l.trim());
    return ls.slice(first, ls.findIndex((l, i) => i > first && !l.trim())).length;
  };
  return out(pages > 0 && pageNums === pages && lead3 === 3 && leadLines("1") === 1 && leadLines("3") === 1, `pages ${pages}, page numbers ${pageNums}, raw lead §3 ${lead3} lines, clean lead §1 ${leadLines("1")} §3 ${leadLines("3")}`);
});

/** The injected contact address: the first x@y.example in the meal-card doc. */
const PLANTED = must(rawOf("2025", "announcement-meal-card.md").match(/[\w.-]+@[\w.-]+\.example/)?.[0], "planted address");
const DOMAIN = PLANTED.split("@")[1]!;
const allRaw = (ed: string) => editionFiles(ed).map((f) => ({ f, raw: rawOf(ed, f) }));
const mealSection2 = (ed: string) => sectionText(doc(ed, "announcement-meal-card"), "2");

A({ id: "K06", part: "content", tier: 1, cls: "P", sids: "S1.06 S5.01 S5.11 S5.16 S5.25 S6.04 S6.09 S6.13 S6.14" }, () => {
  const where = ["2025", "2026"].map((ed) => allRaw(ed).filter((x) => x.raw.includes(PLANTED)).map((x) => x.f).join());
  const body = doc("2025", "announcement-meal-card").body.split("\n");
  const h2 = body.findIndex((l) => /^## 2\./.test(l));
  const shown = (n: number) => body[h2 + n - 1] ?? "";
  const paragraph = !shown(7).trim() && !!shown(8).trim() && !!shown(9).trim() && shown(10).startsWith(PLANTED) && !shown(11).trim();
  const cities = ["Frankfurt", "Ankara"].filter((c) => allRaw("2025").some((x) => x.raw.includes(c)));
  const kraken = D25.map((d) => (d.text.match(/\bKraken\b/g) ?? []).length); // the entity name, also alone (it-security: "the word Kraken")
  const krakenOk = [0, 2, 2, 2, 1, 3, 2, 2].every((min, i) => (kraken[i] ?? 0) >= min);
  const mails = [...new Set(allRaw("2025").flatMap((x) => x.raw.match(/[\w.-]+@[\w.-]+\.\w+/g) ?? []))];
  const phones = [...new Set(allRaw("2025").flatMap((x) => (x.raw.match(/\+?\d[\d ()-]{8,}\d/g) ?? []).filter((p) => p.replace(/\D/g, "").length >= 10)))];
  const te = doc("2025", "travel-expenses");
  const table = (n: string) => sectionText(te, n).split("\n").filter((l) => l.startsWith("|") && !/^\|-/.test(l));
  const [h3, ...r3] = table("3");
  const [h4, ...r4] = table("4");
  const label = (l: string) => l.split("|")[1]!.trim();
  const words = (l: string) => l.split(/[\s|()/]+/).filter(Boolean);
  const hw3 = words(h3 ?? "");
  const hw4 = words(h4 ?? "");
  const twin = r3.length === 4 && r3.map(label).join() === r4.map(label).join() && hw3.length === hw4.length && hw3.every((w, i) => w === hw4[i] || (/^[A-Z]{3}$/.test(w) && /^[A-Z]{3}$/.test(hw4[i]!)));
  const hl = doc("2025", "hr-leave");
  const leave5 = new RegExp(`^\\|[^|\\n]+\\| ${G("q18").expect} \\|$`, "m").test(sectionText(hl, "5"));
  const carry7 = sectionText(hl, "7").includes(G("q22").expect);
  const ok = where.every((w) => w === "announcement-meal-card.md") && paragraph && !cities.length && krakenOk && mails.length === 4 && mails.every((m) => m.endsWith(`@${DOMAIN}`)) && mails.includes(PLANTED) && phones.length <= 1 && twin && leave5 && carry7;
  return out(ok, `planted ${PLANTED} in ${where.join(" / ")}, paragraph ${paragraph}; cities ${cities}; Kraken Air ${kraken}; mails ${mails.length}, phones ${phones.length}; twin tables ${twin}; leave §5 ${leave5}; §7 "${G("q22").expect}" ${carry7}`);
});
A({ id: "K06", part: "english", tier: 1, cls: "E", sids: "S5.11 S5.16 S6.09 S6.14" }, () => {
  const s2 = mealSection2("2025");
  const holidayOk = !/holiday/i.test(doc("2025", "hr-leave").body) && /holiday/i.test(sectionText(doc("2025", "hr-working-hours"), "5"));
  const absent = allRaw("2025").filter((x) => /\bstock\b|\boptions?\b|\bequity\b|company car|\bvehicles?\b|\badopt/i.test(x.raw)).map((x) => x.f);
  const london = allRaw("2025").some((x) => x.raw.includes("London"));
  return out(/password/i.test(s2) && /employee number/i.test(s2) && holidayOk && !absent.length && !london && sectionText(doc("2025", "hr-leave"), "7").includes("31 March"), `holiday ${holidayOk}, absent-topic hits ${absent}, London ${london}`);
});

A({ id: "K07", part: "gold", tier: 1, cls: "P", sids: "S5.23 S5.24 S6.03 S6.56 S6.58 S6.60 S7.44" }, () => {
  const lines = read(GOLD_FILE).trim().split("\n");
  const shape = lines.length === 23 && gold.every((g) => Object.keys(g).length === 5);
  const firsts = ["access", "injection", "out-of-corpus", "paraphrase"].map((t) => firstOf(t).id).join();
  const q06 = G("q06");
  const q02hits = allRaw("2025").flatMap((x) => x.raw.split("\n").filter((l) => new RegExp(`\\b${G("q02").expect}\\b`).test(l)).map((l) => ({ f: x.f, l })));
  const q02only = q02hits.length > 0 && q02hits.every((h) => h.f === "hr-leave.md" && /^\| \d+ \| \d+ \|$/.test(h.l));
  const pairA = must(read("src/explore/similar.ts").match(/kind: "paraphrase", a: "([^"]+)"/)?.[1], "similar.ts paraphrase pair");
  const prefix = G("q02").query.startsWith(pairA.replace(/[?.!]$/, ""));
  const ok = shape && firsts === "q12,q13,q14,q02" && G("q01").query === config.dayQuestion && JSON.stringify(q06.gold_sections) === '["travel-expenses#4"]' && q02only && prefix;
  return out(ok, `${lines.length} lines, firsts ${firsts}, q02 "${G("q02").expect}" rows ${q02hits.length} only hr-leave ${q02only}, pair A prefix ${prefix}`);
});
A({ id: "K07", part: "english", tier: 1, cls: "E", sids: "S6.03 S6.58" }, () => out(!/abroad|foreign|international/i.test(G("q06").query), G("q06").query));

A({ id: "K08", tier: 1, cls: "P", sids: "-" }, () => {
  const keys = new Set(SEC25.flatMap((c) => c.sections.map((s) => `${c.docId}#${s}`)));
  const files = new Set(editionFiles("2025").map((f) => f.replace(/\.md$/, "")));
  const bad = gold.flatMap((g) => g.gold_sections).filter((k) => !keys.has(k) || !files.has(k.split("#")[0]!));
  return out(!bad.length, bad.length ? `unknown gold keys: ${bad}` : `${gold.flatMap((g) => g.gold_sections).length} gold keys all exist`);
});

const WATCH = "| 7 |";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The fixed-300 cut around the leave table: chunks k-1, k (header) and k+1 (row 7). */
function cutOf(ed: string) {
  const hl = doc(ed, "hr-leave");
  const f = fixedSize(hl, 300);
  const i = f.findIndex((c) => c.text.includes(WATCH));
  const [a, b, c] = [f[i - 2], f[i - 1], f[i]].map((x) => must(x, `fixed chunk near ${WATCH}`)) as [Chunk, Chunk, Chunk];
  const s3 = hl.text.indexOf("\n## 3.") + 1;
  const headingLine = hl.text.slice(s3, hl.text.indexOf("\n", s3));
  const firstWord = must(headingLine.match(/^## 3\.\s+(\S+)/)?.[1], "first heading word");
  const headerLine = must(sectionText(hl, "3").split("\n").find(isHeaderRow), "leave table header");
  const row5 = hl.text.indexOf("\n| 5 |") + 1;
  return { hl, f, i, a, b, c, aEnd: (i - 1) * 300, bEnd: i * 300, s3, headingLine, firstWord, headerLine, row5 };
}

A({ id: "K10", tier: 1, cls: "P", sids: "S1.32 S2.20 S2.22 S2.23 S2.24 S2.32 S6.11" }, () => {
  const x = cutOf("2025");
  const t = x.hl.text;
  const inHeading = x.aEnd > x.s3 && x.aEnd < x.s3 + x.headingLine.length && /\p{L}/u.test(t[x.aEnd - 1] ?? "") && /\p{L}/u.test(t[x.aEnd] ?? "");
  const aOk = inHeading && x.a.sections.length === 2 && x.a.sections[1] === "3";
  const bOk = x.b.text.includes(x.headerLine) && x.b.text.includes("|---|---|") && /\| 5 \| \d$/.test(x.b.text) && x.bEnd === x.row5 + 7;
  const c = x.c.text;
  const cOk =
    /^\d \|\n\| 6 \| /.test(c) && c.includes(`| 7 | ${G("q01").expect} |`) && !c.split("\n").some(isHeaderRow) && !c.includes("|---|---|") && !c.includes("## ") &&
    !new RegExp(esc(x.firstWord), "iu").test(c) && JSON.stringify(x.c.sections) === '["3"]';
  const once = t.split(WATCH).length === 2;
  const y = cutOf("2026");
  const twin = y.aEnd === x.aEnd && y.bEnd === x.bEnd && y.c.id.replace("2026", "2025") === x.c.id;
  fact("cut.point", {
    before: t.slice(x.s3, x.aEnd), after: t.slice(x.aEnd, x.s3 + x.headingLine.length), rowSplit: [t.slice(x.row5, x.bEnd), t.slice(x.bEnd, t.indexOf("\n", x.bEnd))],
    ids: [x.a.id, x.b.id, x.c.id], firstHeadingWord: x.firstWord,
  }, "corpus replica (fixedSize 300)");
  const next = must(x.f[x.i + 1], "fixed chunk after the row-7 chunk");
  fact("cut.idNext", next.id, "corpus replica (fixedSize 300)");
  fact("cut.nextStart", must(next.text.trimStart().split(/\s+/)[0], "first word of the next chunk"), "corpus replica (fixedSize 300)");
  return out(aOk && bOk && cOk && once && twin, `${x.a.id} ends "${t.slice(x.s3, x.aEnd)}|" (${x.a.sections}); ${x.b.id} ends "${x.b.text.slice(-8).replace(/\n/g, "⏎")}" (row-5 start + ${x.bEnd - x.row5}); ${x.c.id} starts "${c.slice(0, 10).replace(/\n/g, "⏎")}" ok ${cOk}; once ${once}; 2026 twin ${twin}`);
});

const READ_CHARS = Number(must(read("src/steps/7-rerank.ts").match(/READ_CHARS = (\d+)/)?.[1], "READ_CHARS"));
A({ id: "K11", tier: 1, cls: "P", sids: "S1.08 S2.25 S2.33 S3.10 S4.20 S4.21 S5.31 S6.59 S7.10" }, () => {
  const split = [...SEC25, ...sectionChunks("2026")].filter((c) => /\.\d+$/.test(c.id)).map((c) => c.id);
  const chunk = (id: string) => must(SEC25.find((c) => c.id === id), id).text;
  const h3 = chunk("hr-leave@2025#3");
  const ls = h3.split("\n");
  const rows = ls.filter((l) => l.startsWith("|") && !isHeaderRow(l) && !/^\|-/.test(l));
  const last = (rows[rows.length - 1] ?? "").split("|")[1]?.trim() ?? "";
  const shape = /^\[.+ › 3\. .+\]$/.test(ls[0] ?? "") && ls.some(isHeaderRow) && ls.includes("|---|---|") && rows.length === 15 && !/^\d+$/.test(last) && row(h3, 7) === G("q01").expect;
  const senior = (id: string) => {
    const t = chunk(id);
    const r = t.split("\n").filter((l) => l.startsWith("|") && !/^\|-/.test(l))[2] ?? "";
    return r ? t.indexOf(r) : -1;
  };
  const offs = { row7: h3.indexOf(`| 7 | ${G("q01").expect} |`), row4: h3.indexOf("| 4 |"), travel: senior("travel-expenses@2025#4"), salary: senior("hr-salary-bands@2025#3") };
  const lateGold = gold.flatMap((g) => g.gold_sections.filter((k) => {
    const [d, n] = k.split("#");
    if (!SEC25.some((c) => c.id === `${d}@2025#${n}`)) return false; // an unknown key is K08's finding
    return !chunk(`${d}@2025#${n}`).slice(0, READ_CHARS).includes(g.expect);
  }).map((k) => `${g.id}:${k}`));
  fact("section3", { length: h3.length, headerOffset: h3.indexOf(ls.find(isHeaderRow) ?? "\u0000"), row7Offset: offs.row7 }, "corpus replica (bySection)");
  const offOk = Object.values(offs).every((o) => o >= 0 && o < READ_CHARS);
  return out(!split.length && shape && offOk && !lateGold.length, `split ${split}; #3 shape ${shape} (${rows.length} rows, last "${last}"); offsets ${JSON.stringify(offs)} < ${READ_CHARS}; gold past ${READ_CHARS}: ${lateGold}`);
});

A({ id: "K12", tier: 1, cls: "N", sids: "S2.21" }, () => {
  const hl = doc("2025", "hr-leave");
  const header = must(sectionText(hl, "3").split("\n").find(isHeaderRow), "header");
  const sweep = Object.fromEntries([250, 300, 350, 400, 450, 500, 1000].map((s) => {
    const c = fixedSize(hl, s).find((x) => x.text.includes(WATCH));
    return [s, !!c && c.text.includes(header)];
  }));
  fact("cut.sizeSweep", sweep, "corpus replica (fixedSize)");
  const keep = Object.entries(sweep).filter(([, v]) => v).map(([k]) => k);
  // The page's English list ("250, 350 or 1000"). No size keeps them: no key, so the page fill fails loudly.
  if (keep.length) fact("cut.sizeSweepKeep", keep.length > 1 ? `${keep.slice(0, -1).join(", ")} or ${keep.at(-1)}` : keep[0], "corpus replica (fixedSize)");
  return out(sweep[300] === false, `row-7 chunk holds the header: ${JSON.stringify(sweep)}`);
});

A({ id: "K20", tier: 1, cls: "N", sids: "S1.28 S4.41 S4.48 S6.05" }, () => {
  const changed: Record<string, { a: string; b: string; i: number }[]> = {};
  let shapeOk = true;
  for (const f of editionFiles("2025")) {
    const a = rawOf("2025", f).split("\n");
    const b = rawOf("2026", f).split("\n");
    if (a.length !== b.length) shapeOk = false;
    changed[f] = a.flatMap((l, i) => (l !== b[i] && !/^edition: "\d{4}"$/.test(l) && !HEADER_RULE.test(l.trim()) ? [{ a: l, b: b[i] ?? "", i }] : []));
  }
  const files = Object.entries(changed).filter(([, v]) => v.length).map(([k]) => k).sort();
  const leave = changed["hr-leave.md"] ?? [];
  const leaveOk = leave.length === 10 && leave.every((c) => {
    const n = Number(c.a.match(/^\| (\d+) \|/)?.[1]);
    return n >= 5 && n <= 14 && c.b.startsWith(`| ${n} |`);
  });
  const sec = changed["it-security.md"] ?? [];
  const nums = (s: string): string[] => s.match(/\d+/g) ?? [];
  const secOk = sec.length === 1 && nums(sec[0]!.a).includes(G("q08").expect) && !nums(sec[0]!.b).includes(G("q08").expect);
  const te = changed["travel-expenses.md"] ?? [];
  const teRaw = rawOf("2025", "travel-expenses.md").split("\n");
  const s4 = teRaw.findIndex((l) => /^## 4\./.test(l));
  const s5 = teRaw.findIndex((l) => /^## 5\./.test(l));
  const cellDiff = (x: string, y: string) => x.split("|").filter((c, i) => c !== y.split("|")[i]).length;
  const teOk = te.length === 2 && te.every((c) => c.i > s4 && c.i < s5 && c.a.startsWith("|") && cellDiff(c.a, c.b) === 1);
  const hl25 = doc("2025", "hr-leave");
  const hl26 = doc("2026", "hr-leave");
  const row7 = { y2025: row(hl25.text, 7), y2026: row(hl26.text, 7) };
  fact("edition.row7", row7, "corpus replica");
  const ok = shapeOk && files.join() === "hr-leave.md,it-security.md,travel-expenses.md" && leaveOk && secOk && teOk && row7.y2025 === G("q01").expect && !!row7.y2026 && row7.y2026 !== row7.y2025 && hl25.text.length === hl26.text.length;
  return out(ok, `changed ${files}; leave rows ${leave.length} ${leaveOk}; password line ${secOk}; travel §4 cells ${te.length} ${teOk}; row 7 ${row7.y2025} → ${row7.y2026}; clean length ${hl25.text.length}/${hl26.text.length}`);
});
/** The 2026 value of the day's question, read from the corpus (never typed). */
const ROW7_2026 = must(row(doc("2026", "hr-leave").text, 7), "2026 row 7");

// ═══ T · static layer ═══════════════════════════════════════════════════════════════════════════

const SRC_ANSWER = read("src/steps/8-answer.ts");
A({ id: "T01", tier: 1, cls: "P", sids: "S1.16 S2.18 S4.17 S5.12 S6.24 S6.39 S6.61" }, () =>
  out(
    config.dayQuestion === G("q01").query && config.topK === 5 && config.contextK === 3 && Number.isFinite(config.numCtx) && config.chatModel === "gemma3:4b",
    `dayQuestion == q01 ${config.dayQuestion === G("q01").query}, topK ${config.topK}, contextK ${config.contextK}, numCtx ${config.numCtx}, ${config.chatModel}`,
  ),
);
A({ id: "T02", part: "rules", tier: 1, cls: "P", sids: "S4.18 S4.33 S4.36 S5.10 S5.17 S5.18 S6.26" }, () => {
  const block = SRC_ANSWER.slice(SRC_ANSWER.indexOf("export const RULES"), SRC_ANSWER.indexOf("\n];", SRC_ANSWER.indexOf("export const RULES")));
  const lines = block.split("\n").slice(1);
  const oneLine = lines.length === RULES.length && lines.every((l) => /\/\/ default/.test(l));
  const abstainLines = lines.filter((l) => l.includes("the abstain rule")).length;
  const removes = FRAGMENTS.map((f) => RULES.flatMap((r, i) => (r.includes(f) ? [i] : [])));
  const abstainIdx = RULES.findIndex((r) => r.includes(ABSTAIN));
  const each = removes.length === 2 && removes.every((r) => r.length === 1);
  const idx = removes.map((r) => r[0]).sort().join();
  const dataRule = RULES[3] ?? "";
  const ok = RULES.length === 7 && oneLine && abstainLines === 1 && abstainIdx === 2 && isAbstain(ABSTAIN) && each && idx === "2,4" && !FRAGMENTS.some((f) => dataRule.includes(f));
  return out(ok, `${RULES.length} rules, one line each ${oneLine}, abstain rule at ${abstainIdx}; fragments ${JSON.stringify(FRAGMENTS)} remove ${JSON.stringify(removes)}`);
});
A({ id: "T02", part: "english", tier: 1, cls: "E", sids: "S5.18" }, () => {
  const marker = must(read("src/cli/eval.ts").match(/!text\.includes\("([^"]+)"\)/)?.[1], "eval injection marker");
  return out(marker === "password" && /password/i.test(RULES[4] ?? "") && /password/i.test(mealSection2("2025")), `marker "${marker}"`);
});
A({ id: "T08", tier: 1, cls: "P", sids: "S5.34 S5.35" }, () => {
  const s = score(["a", "b", "c", "d", "e"], ["e"], 5);
  const firstCaps = ABSTAIN.replace(/^\p{L}+/u, (w) => w.toUpperCase());
  return out(s.hit1 === 0 && s.recall === 1 && Math.abs(s.rr - 0.2) < 1e-9 && isAbstain(firstCaps) && isAbstain(ABSTAIN.toUpperCase()), `score ${JSON.stringify(s)}; isAbstain upper ${isAbstain(ABSTAIN.toUpperCase())}`);
});

/** Letters only Turkish uses (built from code points so this file stays free of them). */
const TURKISH = new RegExp(`[${[0xe7, 0x11f, 0x131, 0xf6, 0x15f, 0xfc, 0xc7, 0x11e, 0x130, 0xd6, 0x15e, 0xdc].map((c) => String.fromCodePoint(c)).join("")}]`);
const filesIn = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)]));
const SRC_FILES = filesIn("src").filter((f) => f.endsWith(".ts"));
/** Words built from parts, so a grep for them finds the code that uses them, not this check. */
const W = (...p: string[]) => p.join("");

/** Turkish case rules turn "I" into a dotless i, so an English needle would never match an upper-case answer. */
A({ id: "T03", tier: 1, cls: "N", sids: "S7.35 S7.36" }, () => {
  const needles = [new RegExp(W("toLocale(Lower|Upper)Case\\(\\s*", "['\"]tr")), new RegExp(W("['\"]tr-", "TR['\"]"))];
  const hits = SRC_FILES.flatMap((f) => read(f).split("\n").flatMap((l, i) => (needles.some((re) => re.test(l)) ? [`${f}:${i + 1}`] : [])));
  return out(!hits.length, hits.join(", ") || "no Turkish locale call left in src/");
});

A({ id: "T04", part: "anchors", tier: 1, cls: "N", sids: "S1.04 S1.25 S2.17 S2.21 S2.34 S3.08 S3.22 S3.35 S3.36 S4.12 S4.16 S5.19 S5.20 S5.26 S5.33 S5.37 S5.52 S7.12 S7.13 S7.15 S7.16 S7.20 S7.22 S7.23 S7.24 S7.25 S7.26 S7.28 S7.29 S7.33 S7.38 S7.45" }, () => {
  const has = (f: string, ...needles: string[]) => needles.every((n) => read(f).includes(n));
  const steps = readdirSync("src/steps").filter((f) => /^[1-8]-.+\.ts$/.test(f)).sort();
  const evalLines = read("src/cli/eval.ts").split("\n");
  const blockStart = evalLines.findIndex((l) => /if \(withAnswers\) \{/.test(l));
  const indent = (evalLines[blockStart] ?? "").match(/^\s*/)![0];
  const blockEnd = evalLines.findIndex((l, i) => i > blockStart && l === `${indent}}`);
  const rerankOutside = evalLines.filter((l, i) => /rerank/.test(l) && !/^import /.test(l) && (i < blockStart || i > blockEnd));
  const checks: Record<string, boolean> = {
    "3-chunk size 300": has("src/steps/3-chunk.ts", "size = 300", "fixedSize(d, 300)", 'const CHUNKER: ChunkerName = "section"; // default', '// const CHUNKER: ChunkerName = "fixed"; // alternative'),
    "READ_CHARS 700": READ_CHARS === 700,
    "2-clean YOUR TURN": SRC_CLEAN.includes("// ── YOUR TURN") && /^\];$/m.test(SRC_CLEAN),
    "similarity": has("src/lib/similarity.ts", "export function cosine", "export function l2", "// ── YOUR TURN"),
    "sibling dot": has("test/siblings/siblings.test.ts", "similarity · dot"),
    "KEYS": KEYS.join() === "id,title,edition,department,access,lang",
    "steps 1-5 no generate": steps.filter((f) => /^[1-5]-/.test(f)).every((f) => !read(`src/steps/${f}`).includes("generate")),
    "steps 2-8 readStep": steps.filter((f) => /^[2-8]-/.test(f)).every((f) => read(`src/steps/${f}`).includes("readStep")),
    "no other retrievers": SRC_FILES.every((f) => !new RegExp(`${W("mm", "r")}|${W("bm", "25")}|${W("hyb", "rid")}`, "i").test(read(f))),
    "reranker word only in 7-rerank": [...SRC_FILES, ...filesIn("test")].filter((f) => new RegExp(W("jud", "ge"), "i").test(read(f))).join() === join("src", "steps", "7-rerank.ts"),
    "eval rerank inside withAnswers": blockStart > 0 && blockEnd > blockStart && rerankOutside.length === 0,
    'eval join("+")': has("src/cli/eval.ts", 'join("+")'),
    "question appendFile": has("src/cli/question.ts", "appendFile"),
    "chroma documents:": has("src/lib/chroma.ts", "documents:"),
    "catchup line 7": (read("src/cli/catchup.ts").split("\n")[6] ?? "").includes("Your own functions"),
    "8 step files": steps.length === 8,
    "bruno 01-chroma 5 files": readdirSync("bruno/01-chroma").length === 5,
    "compose": has("compose.yaml", "chromadb/chroma:1.5.9", "8000:8000", "chroma-data:/data"),
    "env CHAT_MODEL": has("env.example", "CHAT_MODEL"),
    "doctor strings": has("src/cli/doctor.ts", "need 22 or newer — https://nodejs.org", "— start the Ollama app", "not pulled — run: ollama pull", "not reachable — run: podman compose up -d   (or set STORE=json in .env)", "missing — run npm run doctor from the repo folder", "slow laptop: answers will take a while — that is fine, the steps still work", "problem(s) — fix them before the day starts.", "Ready."),
    "ollama strings": has("src/lib/ollama.ts", "is not reachable at", "Is it running?", "is the model pulled? Try: ollama pull"),
    "chroma string": has("src/lib/chroma.ts", "Start it: podman compose up -d  (or use --store json)"),
    "data strings": has("src/lib/data.ts", "does not exist yet. Run: npm run step --", "Run it again: npm run step --"),
    "clean string": SRC_CLEAN.includes("changed after step 1 ran. Run it again: npm run step -- 1"),
    "retrieve string": has("src/steps/6-retrieve.ts", "Vectors from two models live in different spaces — run steps 4 and 5 again."),
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return out(!bad.length, bad.length ? `missing: ${bad.join("; ")}` : `${Object.keys(checks).length} anchors present`);
});
A({ id: "T04", part: "english", tier: 1, cls: "E", sids: "S7.15 S7.26" }, () =>
  out(!TURKISH.test(read("src/cli/ask.ts").split("\n")[14] ?? "") && !TURKISH.test(read("src/cli/step.ts").split("\n")[3] ?? ""), "ask.ts:15 and step.ts:4"),
);

const SOLUTION_NAME = must(
  Object.entries((await import(resolve("solutions", SOLUTION_FILE))) as Record<string, unknown>).find(([, v]) => v instanceof RegExp)?.[0],
  "solution export name",
);
A({ id: "T06", tier: 1, cls: "N", sids: "S2.13 S2.17 S2.34 S4.39 S6.53 S6.54 S6.65 S7.27 S7.49", needsAll: true }, () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(npm, args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env } });
    return { code: r.status, text: `${r.stdout}${r.stderr}` };
  };
  const test = run(["test"]);
  const sib = run(["run", "check:sibling", "--", "--reporter=verbose"]);
  const failedSiblings = new Set([...sib.text.matchAll(/(?:FAIL|×|✗)\s+test\/siblings\/\S+ > ([^>\n]+?) >/g)].map((m) => m[1]!.trim()));
  const sol = run(["run", "check:sibling", "--", "--reporter=verbose"], { SOLUTIONS: "1" });
  const ok = test.code === 0 && sib.code !== 0 && failedSiblings.size === 3 && sol.code === 0 && sol.text.includes(SOLUTION_NAME);
  return out(ok, `npm test ${test.code}; check:sibling ${sib.code} (${failedSiblings.size} red: ${[...failedSiblings].join(" | ")}); SOLUTIONS=1 ${sol.code}, names ${SOLUTION_NAME} ${sol.text.includes(SOLUTION_NAME)}`);
});

/** Every text file the course ships: tracked files, with logs/, corpus/ and the gold file read from their override dirs. */
const shippedFiles = (() => {
  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const textFile = /\.(ts|js|mjs|cjs|json|jsonl|md|mdx|astro|css|html|svg|yaml|yml|bru|txt|env|example)$|(^|\/)\.[a-z]+$/;
  const own = tracked.filter((f) => !/^(logs|corpus)\//.test(f) && f !== "eval/gold.jsonl" && f !== "package-lock.json" && !/check-legacy\.(ts|mjs)$/.test(f));
  return [...own.map((f) => resolve(f)), ...filesIn(LOGS), ...filesIn(CORPUS), GOLD_FILE].filter((f) => textFile.test(f) && existsSync(f));
})();
A({ id: "T07", part: "markers", tier: 1, cls: "N", sids: "-" }, () => {
  const markers = regexBlock(read("src/cli/check-legacy.ts"), "MARKERS");
  const hits = shippedFiles.flatMap((f) => read(f).split("\n").flatMap((l, i) => markers.filter((m) => m.test(l)).map((m) => `${f.replace(`${process.cwd()}/`, "")}:${i + 1} ${m}`)));
  return out(markers.length > 10 && !hits.length, hits.length ? hits.slice(0, 5).join("; ") : `${markers.length} markers, ${shippedFiles.length} files, 0 hits`);
});
/** The site's "scan everything" lists hit in these texts: STAGE_TR (or the older single STAGE) and CALQUE, read by path, never copied. */
function stageCalqueHits(texts: { f: string; t: string }[]): Outcome {
  const scripts = ["check-dist.mjs", "style-lists.mjs"].map((f) => join(SITE, "scripts", f)).filter((f) => existsSync(f));
  if (!scripts.length) return out(false, `site scripts not found under ${SITE} (set SITE_DIR)`);
  const lits = new Map(scripts.flatMap((f) => [...read(f).matchAll(/^(?:export )?const (STAGE_TR|STAGE|CALQUE) = \/(.+)\/([a-z]*);$/gm)].map((m) => [m[1]!, new RegExp(m[2]!, m[3])] as const)));
  const res = [must(lits.get("STAGE_TR") ?? lits.get("STAGE"), "STAGE_TR or STAGE in the site scripts"), must(lits.get("CALQUE"), "CALQUE in the site scripts")];
  const hits = texts.flatMap(({ f, t }) => res.flatMap((re) => (t.match(re) ? [`${f.split("/").pop()}: ${t.match(re)![0]}`] : [])));
  return out(!hits.length, hits.slice(0, 6).join("; ") || `${texts.length} texts clean`);
}
A({ id: "T07", part: "stage+calque data", tier: 1, cls: "E", sids: "-" }, () => {
  const pairs = [...read("src/explore/similar.ts").matchAll(/[ab]: "([^"]+)"/g)].map((m) => m[1]!);
  return stageCalqueHits([...[...filesIn(CORPUS), GOLD_FILE].map((f) => ({ f, t: read(f) })), { f: "RULES", t: RULES.join("\n") }, { f: "similar.ts pairs", t: pairs.join("\n") }]);
});
// The logs half runs after a capture (never in --offline): until the English capture the logs are the Turkish day's.
A({ id: "T07", part: "stage+calque logs", tier: 1, cls: "E", sids: "-", logs: ["ask-out-of-corpus", "ask-out-of-corpus-rule-off", "map.json"] }, () =>
  stageCalqueHits(filesIn(LOGS).map((f) => ({ f, t: read(f) }))),
);

/**
 * T05 · no Turkish left outside the one Turkish document. A word with a Turkish letter may appear only if the
 * Turkish document (either edition) has the same word: its header and footer in the cleaning rules and tests,
 * the Turkish sentence in similar.ts, and logs that print its text. Two files are Turkish on purpose (the
 * homework answer and its test), and the TR day's "7 years" phrase may appear nowhere.
 */
const TR_DOC_FILES = filesIn(CORPUS).filter((f) => /[\\/]it-security\.md$/.test(f));
/** Proper names English text spells with a Turkish letter (a public holiday in hr-working-hours). */
const TR_NAMES = [W("Atat", String.fromCodePoint(0xfc), "rk")];
const TR_WORDS = new Set([...TR_DOC_FILES.flatMap((f) => read(f).match(/\p{L}+/gu) ?? []), ...TR_NAMES]);
const TR_WHOLE_FILES = [join("solutions", SOLUTION_FILE), join("test", "siblings", "siblings.test.ts")].map((f) => resolve(f));
const TR_DAY_PHRASE = new RegExp(`7 y${String.fromCodePoint(0x131)}ll${String.fromCodePoint(0x131)}k`, "i");
const strayTurkish = (files: string[]) =>
  files.flatMap((f) => {
    const name = f.replace(`${process.cwd()}/`, "");
    return read(f).split("\n").flatMap((l, i) => {
      const where = `${name}:${i + 1}`;
      if (TR_DAY_PHRASE.test(l)) return [`${where} "${l.match(TR_DAY_PHRASE)![0]}"`];
      if (TR_DOC_FILES.includes(f) || TR_WHOLE_FILES.includes(f)) return [];
      // a JSON escape (map.json) must not glue its letter onto the next word: "\nGİZLİ" is "GİZLİ"
      const bad = (l.replace(/\\[nrt]/g, " ").match(/\p{L}+/gu) ?? []).filter((w) => w.length > 1 && TURKISH.test(w) && !TR_WORDS.has(w));
      return bad.length ? [`${where} ${bad.slice(0, 3).join(" ")}`] : [];
    });
  });
A({ id: "T05", part: "files", tier: 1, cls: "N", sids: "S1.01 S3.02" }, () => {
  const files = shippedFiles.filter((f) => !f.startsWith(`${LOGS}/`));
  const hits = strayTurkish(files);
  return out(TR_DOC_FILES.length > 0 && !hits.length, hits.slice(0, 6).join("; ") || `${files.length} files, Turkish only from ${TR_DOC_FILES.length} it-security files (${TR_WORDS.size} words)`);
});
A({ id: "T05", part: "logs", tier: 1, cls: "N", sids: "S1.01 S3.02", logs: ["04b-similar", "map.json"] }, () => {
  const hits = strayTurkish(filesIn(LOGS));
  return out(!hits.length, hits.slice(0, 6).join("; ") || `${filesIn(LOGS).length} logs, Turkish only from it-security`);
});

// ═══ L · log layer ══════════════════════════════════════════════════════════════════════════════

/** The logs capture.ts writes: every `await record|run("name"` plus the files it copies into logs/. */
const CAPTURED = [
  ...[...SRC_CAPTURE.matchAll(/await (?:record|run)\("([\w-]+)"/g)].map((m) => m[1]!),
  ...[...SRC_CAPTURE.matchAll(/copyFile\("[^"]+", "logs\/([\w.-]+)"\)/g)].map((m) => m[1]!),
];
A({ id: "L00", part: "present", tier: 1, cls: "N", sids: "-" }, () => {
  if (!existsSync(LOGS)) return out(false, `logs directory missing: ${LOGS}`);
  const missing = REQUIRED_LOGS.filter((n) => !hasLog(n));
  const empty = REQUIRED_LOGS.filter((n) => hasLog(n) && !n.endsWith(".json") && !ln(n, 1).startsWith("$ "));
  const manifest = [...REQUIRED_LOGS, ...NOT_CAPTURED_YET].sort().join() === [...new Set(CAPTURED)].sort().join();
  return out(!missing.length && !empty.length && manifest,
    `${REQUIRED_LOGS.length - missing.length}/${REQUIRED_LOGS.length} required logs; missing [${missing.join(" ")}]; no "$ " line 1 [${empty.join(" ")}]; manifest == capture.ts ${manifest}`);
});

const QUESTION_LOGS = ["question-0-bare", "question-1-fixed", "question-2-section", "question-3-full", "question-4-2026"];
const EXP = G("q01").expect;
/** A number in the bare answer that is neither the 7 of the question nor the right answer. */
/** question-0-bare's answer: the paragraph that starts on line 6. */
const qBare = () => {
  const ls = L("question-0-bare").slice(5);
  return ls.slice(0, Math.max(0, ls.findIndex((l) => !l.trim()))).join(" ");
};
const wrongNumber = (a: string) => a.match(new RegExp(`\\b(?!7\\b|${EXP}\\b)\\d+\\b`))?.[0];

A({ id: "L01", tier: 1, cls: "N", sids: "S1.10 S1.12 S1.15 S1.47", logs: ["question-0-bare"] }, () => {
  const ls = L("question-0-bare");
  const ledger = ls.findIndex((l) => /^\s+LEDGER/.test(l));
  const ok = ln("question-0-bare", 3).startsWith("━━ ") && ln("question-0-bare", 4) === "   HOW   bare model, no documents" && ls[4] === "" && !!ls[5]?.trim() && ls[6] === "" && (ls[7] ?? "").startsWith("   LEDGER") && !ls.slice(0, ledger).some((l) => RE_SRC.test(l));
  return out(ok, `answer line 6: "${(ls[5] ?? "").slice(0, 60)}…"`);
});
A({ id: "L02", tier: 2, cls: "P", sids: "S1.02 S1.10 S1.27 S1.42 S2.01 S6.38", logs: ["00-bare", "question-0-bare"] }, () => {
  const a = [bareAnswer("00-bare"), qBare()];
  fact("bare.answer", a[1], "question-0-bare");
  fact("bare.number", wrongNumber(a[1]!), "question-0-bare");
  return out(a.every((x) => !!wrongNumber(x) && !isAbstain(x)), `wrong number ${wrongNumber(a[1]!)} (right: ${EXP})`);
});
A({ id: "L03", part: "hedge", tier: 2, cls: "E", sids: "S1.10 S1.29 S2.01 S6.38", logs: ["00-bare", "question-0-bare"] }, () =>
  out([bareAnswer("00-bare"), qBare()].every((a) => /depend|vary|varies|differs/i.test(a)), qBare().slice(0, 80)),
);
A({ id: "L03", part: "usually", tier: 2, cls: "E", soft: true, sids: "S1.29", logs: ["question-0-bare"] }, () =>
  out(/\b(usually|typically|generally|normally)\b[^.]*?\b\d+\s+(working\s+)?days\b/i.test(qBare()), "the page copies the adverb the log has"),
);
A({ id: "L04", tier: 2, cls: "N", sids: "S1.11", logs: ["question-0-bare"] }, () => {
  const a = qBare();
  const m = a.match(/(\d+)[^\d+]*\+\s*(\d+)/);
  const s = m ? { a: +m[1]!, b: +m[2]!, sum: +m[1]! + +m[2]! } : null;
  fact("bare.sum", s, "question-0-bare");
  return out(!s || String(s.sum) === wrongNumber(a), s ? `${s.a} + ${s.b} = ${s.sum}, headline ${wrongNumber(a)}` : "no (a + b) in the answer");
});
A({ id: "L05", tier: 1, cls: "N", sids: "S1.18", logs: ["00-bare", "question-0-bare"] }, () => out(bareAnswer("00-bare") === qBare(), "same prompt, seed 42"));
A({ id: "L06", tier: 1, cls: "N", sids: "S1.33 S1.34 S1.52", logs: ["00-bare", "08-answer"] }, () => {
  const bare = num("00-bare", /(\d+) prompt tokens/);
  const rag = num("08-answer", /(\d+) prompt tokens/);
  fact("tokens.bare", bare, "00-bare");
  fact("tokens.rag", rag, "08-answer");
  return out(ln("00-bare", 5).includes(`WHAT  ask ${config.chatModel} directly — no documents, no search`) && bare < rag, `bare ${bare} < rag ${rag}`);
});
A({ id: "L07", tier: 1, cls: "P", sids: "S1.01 S4.17 S6.38 S6.61 S7.08", logs: ["00-bare", "06-retrieve", "07-rerank", ...QUESTION_LOGS] }, () => {
  const q = config.dayQuestion;
  const banners = QUESTION_LOGS.map((n) => ln(n, 3));
  const ok = ln("00-bare", 4).endsWith(q) && ln("06-retrieve", 4).endsWith(q) && ln("07-rerank", 4).includes(q) && banners.every((b) => b.endsWith(`  ${q}`)) && new Set(banners).size === 1;
  return out(ok, `day question "${q}" in 00-bare, 06, 07 and ${banners.length} banners`);
});
A({ id: "L08", tier: 1, cls: "P", sids: "S1.15", logs: QUESTION_LOGS }, () => out(QUESTION_LOGS.every((n) => ln(n, 3).startsWith(`━━ ${BANNER}  `)), `banner "${BANNER}" read from question.ts`));

A({ id: "L10", tier: 1, cls: "N", sids: "S2.02 S2.03 S7.02 S7.03 S7.04", logs: ["01-load"] }, () => {
  const rows = L("01-load").flatMap((l) => {
    const m = l.match(/^\s+([a-z-]+)\s{2,}(\w\w)\s+(all|hr-only)\s+(\d+) chars\s+(\d+) lines/);
    return m ? [{ id: m[1]!, lang: m[2]!, access: m[3]!, chars: +m[4]! }] : [];
  });
  const langs = rows.map((r) => r.lang);
  const odd = rows.filter((r) => langs.filter((x) => x === r.lang).length === 1).map((r) => r.id);
  const total = num("01-load", /OUT\s+\d+ documents · (\d+) characters/);
  const ok = rows.length === 8 && /OUT\s+8 documents/.test(TXT("01-load")) && rows.map((r) => r.id).join() === editionFiles("2025").map((f) => f.replace(/\.md$/, "")).join() &&
    rows.filter((r) => r.id.startsWith("announcement-")).length === 1 && rows.filter((r) => r.access === "hr-only").map((r) => r.id).join() === "hr-salary-bands" &&
    odd.join() === "it-security" && sum(rows.map((r) => r.chars)) === total;
  return out(ok, `${rows.length} docs, odd ${odd}, chars ${sum(rows.map((r) => r.chars))} == ${total}`);
});

const box = (n: string, from: RegExp, to: RegExp) => {
  const ls = L(n);
  const a = ls.findIndex((l) => from.test(l));
  const b = ls.findIndex((l, i) => i > a && to.test(l));
  return ls.slice(a + 1, b < 0 ? undefined : b).filter((l) => /^\s+│/.test(l)).map((l) => l.replace(/^\s+│ ?/, ""));
};
A({ id: "L11", part: "clean", tier: 1, cls: "N", sids: "S2.04 S2.06 S2.07 S2.09 S2.10 S6.64 S7.05", logs: ["02-clean"] }, () => {
  const t = TXT("02-clean");
  const m = must(t.match(/(\d+) lines → (\d+) lines · (\d+) noise lines removed/), "OUT");
  const per = Object.fromEntries(L("02-clean").flatMap((l) => {
    const x = l.match(/^\s+([a-z-]+)\s+−\s*(\d+) noise lines/);
    return x ? [[x[1]!, +x[2]!] as const] : [];
  }));
  const perOk = D25.every((d) => per[d.id] === (d.id === ODD.id ? 2 : 3) * pagesOf(d) && per[d.id] === d.noiseLines);
  const before = box("02-clean", /before \(hr-leave/, /^\s+after:/);
  const after = box("02-clean", /^\s+after:/, /TIME/);
  const beforeOk = HEADER_RULE.test(before[0] ?? "") && !!before[1]?.trim() && !before[1]!.startsWith("#") && before.some((l) => l.startsWith("# ")) && before.some((l) => l.startsWith("## 1."));
  const afterOk = (after[0] ?? "").startsWith("# ") && after[1] === "" && (after[2] ?? "").startsWith("## 1.");
  const ok = t.includes(`(${NOISE.length} rules)`) && sum(Object.values(per)) === +m[3]! && +m[3]! < +m[1]! - +m[2]! && perOk && beforeOk && afterOk;
  return out(ok, `per-doc noise ${JSON.stringify(per)} (3 x pages, ${ODD.id} 2 x pages: ${perOk}); before ${beforeOk}, after ${afterOk}`);
});
A({ id: "L11", part: "time", tier: 3, cls: "N", sids: "S7.05", logs: ["02-clean"] }, () => out(timeMs("02-clean") < 100, `${timeMs("02-clean")} ms`));

A({ id: "L12", tier: 1, cls: "N", sids: "S1.14 S2.20 S2.21 S2.23 S2.24 S2.29 S2.34 S5.27 S6.11 S6.42 S7.05 S7.39", logs: ["03-chunk-fixed"] }, () => {
  const o = outCounts("03-chunk-fixed");
  fact("chunks.fixed", o, "03-chunk-fixed");
  const x = cutOf("2025");
  const blk = chunkBlock("03-chunk-fixed");
  const b = blk.body;
  const holding = L("03-chunk-fixed").filter((l) => /the chunk holding "\| 7 \|"/.test(l)).length;
  const ok = ln("03-chunk-fixed", 5).includes("a cut every 300 characters") && o.max === 300 && holding === 1 && blk.id === x.c.id && blk.sections === "3" &&
    /^\d+ \|$/.test(b[0] ?? "") && b[1] === `| 6 | ${row(x.hl.text, 6)} |` && b.includes(`| 7 | ${EXP} |`) && !b.some(isHeaderRow) && !b.includes("|---|---|") && !new RegExp(esc(x.firstWord), "iu").test(b.join("\n"));
  return out(ok, `${blk.id} (replica ${x.c.id}) starts "${b[0]}" / "${b[1]}"`);
});
A({ id: "L13", tier: 1, cls: "N", sids: "S2.10 S2.20 S2.26 S2.34 S3.28 S7.05 S7.11 S7.39", logs: ["03-chunk-section"] }, () => {
  const o = outCounts("03-chunk-section");
  fact("chunks.section", o, "03-chunk-section");
  const blk = chunkBlock("03-chunk-section");
  const b = blk.body;
  const rows = b.filter((l) => l.startsWith("|") && !isHeaderRow(l) && !/^\|-/.test(l)).length;
  const ok = ln("03-chunk-section", 5).includes("a cut at every '## n.' heading") && blk.id === "hr-leave@2025#3" && blk.sections === "3" && /^\[.+ › 3\. .+\]$/.test(b[0] ?? "") &&
    b.some(isHeaderRow) && b.includes("|---|---|") && b.includes(`| 7 | ${EXP} |`) && rows === 15 && o.min <= 120;
  return out(ok, `${blk.id}, ${rows} rows, min ${o.min}`);
});
A({ id: "L14", tier: 1, cls: "N", sids: "S2.29 S5.31", logs: ["03-chunk-fixed", "03-chunk-section"] }, () => {
  const f = outCounts("03-chunk-fixed");
  const s = outCounts("03-chunk-section");
  const headings = sum(D25.map((d) => (d.text.match(/^## \d+\./gm) ?? []).length));
  return out(f.count >= 1.5 * s.count && s.avg >= 1.5 * f.avg && s.count === headings + 1, `fixed ${f.count} x ${f.avg} · section ${s.count} x ${s.avg} · headings ${headings} + 1`);
});

const hasExp = (s: string, v = EXP) => new RegExp(`\\b${v}\\b`).test(s);
A({ id: "L20", tier: 2, cls: "P", sids: "S1.17 S1.49 S2.19 S2.25 S5.22 S6.22 S6.38 S6.42 S7.35", logs: ["question-1-fixed", "03-chunk-fixed"] }, () => {
  const n = "question-1-fixed";
  const a = answer(n);
  const how = ln(n, 4);
  const srcLines = L(n).filter((l) => RE_SRC.test(l)).length;
  // English run (P4 round 2, re-narrated): fixed chunking loses the table, and the model answers a WRONG number WITH a source.
  // The number is the one next to "working days" in the chunk it cites ([1] = the §4 block-limit chunk), never the row's.
  const days = a.match(/\b(\d+) working days\b/)?.[1];
  const cite = Number(a.match(/\[(\d)\]/)?.[1] ?? 0);
  const cited = FIX25.find((c) => c.id === sources(n)[cite - 1]);
  const ok = !isAbstain(a) && !!days && !hasExp(a) && cite === 1 && !!cited && cited.text.includes(`${days} working days`) && !cited.text.includes("| 7 |") &&
    !sources(n).includes(chunkBlock("03-chunk-fixed").id) && how.includes("chunker fixed") && how.includes("in-memory search (black box)") &&
    ln(n, 5) === "" && !!ln(n, 6).trim() && ln(n, 7) === "" && srcLines === 3 && ln(n, 11) === "";
  fact("answers.question-1-fixed", a, n);
  return out(ok, `"${a}" sources ${sources(n).join(" ")}; [${cite}] holds "${days} working days": ${!!cited?.text.includes(`${days} working days`)}`);
});
A({ id: "L21", tier: 1, cls: "N", sids: "S2.19 S2.27 S3.01 S3.03 S5.22 S6.38", logs: ["question-2-section", "question-1-fixed"] }, () => {
  const a = answer("question-2-section");
  const sameHow = ln("question-2-section", 4) === ln("question-1-fixed", 4).replace("chunker fixed", "chunker section");
  return out(hasExp(a) && a.includes("[1]") && !isAbstain(a) && sources("question-2-section")[0] === "hr-leave@2025#3" && sameHow, `"${a}" HOW differs only in the chunker: ${sameHow}`);
});
A({ id: "L22", tier: 1, cls: "N", sids: "S1.17 S1.19 S1.31 S1.36 S1.43 S1.44 S1.47 S1.54 S3.01 S3.26 S6.38 S7.48", logs: ["question-3-full", "question-2-section", "08-answer"] }, () => {
  const n = "question-3-full";
  const a = answer(n);
  const s = sources(n);
  fact("answers.question-3-full", a, n);
  const ok = ln(n, 4).startsWith("   HOW   chroma store") && ln(n, 4).includes("chunker section") && new RegExp(`\\b${EXP}\\b.*\\[1\\]`).test(a) && s.length === 3 && s.every((x) => x.startsWith("hr-leave@2025#")) &&
    s[0] === "hr-leave@2025#3" && a === answer("question-2-section") && a === answer("08-answer") && TXT(n).includes("LEDGER (.cache/question-ledger.jsonl)") &&
    s.join() === sources("08-answer").join();
  return out(ok, `"${a}" ${s.join(" ")} (08-answer ${sources("08-answer").join(" ")})`);
});
A({ id: "L23", tier: 2, cls: "E", soft: true, sids: "S5.21", logs: ["question-2-section", "question-3-full", "08-answer", "stuff-everything", "question-4-2026"] }, () => {
  const a = [answer("question-2-section"), answer("question-3-full"), answer("08-answer"), stuffAnswer()];
  return out(a.every((x) => x.includes(`${EXP} working days`)) && answer("question-4-2026").includes(`${ROW7_2026} working days`), "the page copies the phrase the log has");
});
/** Ledger rows: [answer preview, how]. */
const ledger = (n: string) => L(n).filter((l) => /^\s+\d\d:\d\d\s{2}/.test(l)).map((l) => l.replace(/^\s+\d\d:\d\d\s{2}/, "").split(/\s{2,}/));
A({ id: "L24", tier: 1, cls: "P", sids: "S1.03 S1.20 S2.28 S6.41", logs: ["question-4-2026", "question-2-section"] }, () => {
  const r = ledger("question-4-2026");
  const p = (i: number) => r[i]?.[0] ?? "";
  const ok = r.length === 5 && (r[0]?.[1] ?? "").includes("bare model, no documents") && !hasExp(p(0)) && p(1) === preview(answer("question-1-fixed"), 46) && !hasExp(p(1)) && !isAbstain(answer("question-1-fixed")) && hasExp(p(2)) && hasExp(p(3)) && hasExp(p(4), ROW7_2026) && /^\s+LEDGER/.test(ln("question-4-2026", 12));
  const r2 = ledger("question-2-section");
  const ok2 = r2.length === 3 && (r2[0]?.[1] ?? "").includes("bare model") && (r2[1]?.[1] ?? "").includes("chunker fixed") && (r2[2]?.[1] ?? "").includes("chunker section");
  fact("ledger.previews", r.map((x) => x[0]), "question-4-2026");
  return out(ok && ok2, r.map((x) => (x[0] ?? "").slice(0, 30)).join(" | "));
});
A({ id: "L25", tier: 1, cls: "N", sids: "S1.14 S7.14", logs: ["01-load"] }, () => {
  const q = readdirSync(LOGS).filter((f) => /^question-.*\.txt$/.test(f));
  const named = new Set(readdirSync(LOGS).filter((f) => f.endsWith(".txt")).flatMap((f) => [...read(join(LOGS, f)).matchAll(/→\s+data\/([1-8])-[a-z]+\.json/g)].map((m) => m[1]!)));
  return out(q.length === 5 && named.size === 8, `${q.length} question logs; step data files named: ${[...named].sort().join(",")}`);
});

A({ id: "L30", part: "vectors", tier: 1, cls: "N", sids: "S3.04 S3.05 S3.07 S3.09 S5.45 S5.49 S6.40 S7.06 S7.41", logs: ["04-embed"] }, () => {
  const m = must(TXT("04-embed").match(/(\d+) vectors · 1024 numbers each · (\d+) computed, (\d+) from cache/), "04-embed OUT");
  return out(+m[1]! === SEC25.length && +m[2]! + +m[3]! === +m[1]! && TXT("04-embed").includes(`to ${config.embedModel}`) && TXT("04-embed").includes("length (norm) of that vector: 1.000"), `${m[1]} vectors == ${SEC25.length} section chunks`);
});
A({ id: "L30", part: "warm cache", tier: 3, cls: "N", sids: "S5.45", logs: ["04-embed"] }, () => out(/ 0 computed, /.test(TXT("04-embed")), "needs a warm .cache/"));

const STOP = new Set("the and for are how many what much with our you your its per any all can not has have does did was were will from this that there into when which who".split(" "));
const pairs = () =>
  L("04b-similar").flatMap((l, i, ls) => {
    const m = l.match(/^\s+(\d\.\d{3}) [█░]+\s+(.+)$/);
    return m ? [{ score: +m[1]!, kind: m[2]!.trim(), a: (ls[i + 1] ?? "").trim(), b: (ls[i + 2] ?? "").trim() }] : [];
  });
const pair = (k: string) => must(pairs().find((p) => (k === "cross" ? p.kind.includes("↔") : p.kind === k)), `pair ${k}`);
A({ id: "L31", part: "relations", tier: 1, cls: "N", sids: "S3.03 S3.11 S3.12 S3.13 S3.14 S3.23 S4.11 S7.37 S7.41", logs: ["04b-similar"] }, () => {
  const [para, cross, twin, neg, unrel] = ["paraphrase", "cross", "twin tables", "negation trap", "unrelated"].map(pair) as [ReturnType<typeof pair>, ReturnType<typeof pair>, ReturnType<typeof pair>, ReturnType<typeof pair>, ReturnType<typeof pair>];
  const toks = (s: string) => s.split(/\s+/);
  const diff = toks(neg.a).filter((t) => !toks(neg.b).includes(t)).length + toks(neg.b).filter((t) => !toks(neg.a).includes(t)).length;
  const words = (s: string) => new Set((s.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((w) => !STOP.has(w)));
  const shared = [...words(para.a)].filter((w) => words(para.b).has(w));
  const gap = para.score - unrel.score;
  const ok = pairs().length === 5 && Math.max(...pairs().map((p) => p.score)) === twin.score && neg.score >= 0.8 && neg.score > para.score && diff <= 2 && gap > 0 && gap <= 0.1 &&
    [cross, twin, neg].every((p) => para.score < p.score) && unrel.score >= 0.3 && unrel.score <= 0.7 && cross.score >= para.score && !shared.length;
  fact("similar.scores", Object.fromEntries(pairs().map((p) => [p.kind, p.score])), "04b-similar");
  return out(ok, `${pairs().map((p) => `${p.kind} ${p.score}`).join(", ")}; gap ${gap.toFixed(3)}; negation differs by ${diff} tokens; shared ${shared}`);
});
A({ id: "L31", part: "cross-lingual margin", tier: 2, cls: "N", soft: true, sids: "S3.14 S7.37", logs: ["04b-similar"] }, () => {
  const c = pair("cross").score;
  return out(c - pair("unrelated").score >= 0.15 && c > pair("paraphrase").score + 0.05, `cross ${c}`);
});
A({ id: "L32", tier: 2, cls: "N", sids: "S2.10 S3.16 S3.17 S3.18 S3.19", logs: ["04b-map", "map.json"] }, () => {
  const t = TXT("04b-map");
  const pc = must(t.match(/PC1 keeps ([\d.]+)% · PC2 ([\d.]+)%/), "PC line");
  const near = must(t.match(/lands next to: ([^\n]+?)\s+\(on the 2-D/)?.[1], "lands next to").split(", ");
  const m = JSON.parse(read(logPath("map.json"))) as { points: { id: string; docId: string; x: number; y: number; text: string }[] };
  const P = m.points;
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const byDoc = new Map<string, typeof P>();
  for (const p of P) byDoc.set(p.docId, [...(byDoc.get(p.docId) ?? []), p]);
  const cen = new Map([...byDoc].map(([k, ps]) => [k, { x: sum(ps.map((p) => p.x)) / ps.length, y: sum(ps.map((p) => p.y)) / ps.length }] as const));
  const iso = [...cen].map(([k, c]) => [k, Math.min(...[...cen].filter(([j]) => j !== k).map(([, c2]) => d(c, c2)))] as const).sort((a, b) => b[1] - a[1]);
  const odd = byDoc.get(ODD.id) ?? [];
  const meanX = sum(P.map((p) => p.x)) / P.length;
  const side = (cen.get(ODD.id)?.x ?? 0) < meanX ? 1 : -1;
  const extreme = [...P].sort((a, b) => side * (a.x - b.x)).slice(0, odd.length);
  const oddShare = extreme.filter((p) => p.docId === ODD.id).length / Math.max(1, odd.length);
  const mp = (a: typeof P) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) { s += d(a[i]!, a[j]!); n++; } return s / n; };
  const s1 = P.filter((p) => /#1$/.test(p.id) && p.docId !== ODD.id && !p.docId.startsWith("announcement-"));
  const zero = P.find((p) => p.id === `${ODD.id}@2025#0`)?.text ?? "";
  const zeroOk = new RegExp(`^\\[${esc(ODD.title)}\\]\\n.+\\n\\n# ${esc(ODD.title)}$`).test(zero);
  fact("map.pca", { pc1: +pc[1]!, pc2: +pc[2]!, mostIsolated: iso[0]?.[0], oddShare }, "04b-map, map.json");
  const ok = +pc[1]! > +pc[2]! && +pc[1]! + +pc[2]! > 10 && +pc[1]! + +pc[2]! < 40 && P.length === SEC25.length && near.length === 3 && !near.includes("hr-leave@2025#3") &&
    iso[0]?.[0] === ODD.id && iso[0][1] >= 1.2 * (iso[1]?.[1] ?? Infinity) && oddShare >= 0.8 && s1.length === 6 && mp(s1) <= 0.5 * mp(P) && zeroOk;
  return out(ok, `PC ${pc[1]}+${pc[2]}; near ${near}; isolated ${iso[0]?.[0]} ${iso[0]?.[1].toFixed(3)} vs ${iso[1]?.[0]} ${iso[1]?.[1].toFixed(3)}; extreme-x share ${oddShare.toFixed(2)}; §1 ${mp(s1).toFixed(3)} vs ${mp(P).toFixed(3)}; #0 ${zeroOk}`);
});

A({ id: "L40", tier: 1, cls: "N", sids: "S1.25 S3.27 S3.31", logs: ["05-store-json"] }, () => {
  const t = TXT("05-store-json");
  const m = t.match(/(\d+) records added · (\d+) in the store · editions: 2025$/m);
  return out(ln("05-store-json", 1) === "$ npm run step -- 5 --store json" && num("05-store-json", /(\d+) vectors, edition 2025/) === SEC25.length && !!m && +m[1]! === SEC25.length && m[1] === m[2], `${m?.[1]} records`);
});
const storeLogs = ["05-store-chroma", "ingest-fixed", "ingest-section", "ingest-2026"];
const top5 = (n: string, who: RegExp) => must(L(n).find((l) => who.test(l.trim())), `${who} in ${n}`).trim().replace(who, "").trim().split(/\s+/);
A({ id: "L41", tier: 1, cls: "N", sids: "S3.32 S3.33 S3.34 S3.37 S6.38 S6.40 S6.64 S7.07 S7.38", logs: [...storeLogs, "06-retrieve"] }, () => {
  const same = storeLogs.map((n) => top5(n, /^JSON \(brute force\)/).join() === top5(n, /^chroma(?=\s+\S+@)/).join() && TXT(n).includes("identical ✓"));
  const c = TXT("05-store-chroma");
  const m = c.match(/(\d+) records added · (\d+) in the store/);
  const first = top5("05-store-chroma", /^chroma(?=\s+\S+@)/);
  const ok = same.every(Boolean) && c.includes('Chroma collection "kraken-policies" (HNSW index, cosine)') && c.includes("replace edition") && first[0] === "hr-leave@2025#3" &&
    !!m && +m[1]! === SEC25.length && first.join() === hits("06-retrieve").slice(0, 5).map((h) => h.id).join();
  return out(ok, `json == chroma in ${same.filter(Boolean).length}/4; chroma top-5 ${first.join(" ")}`);
});

const FILTER_LATEST = '{"edition":"2025","access":["all"]}';
A({ id: "L50", part: "rows", tier: 1, cls: "N", sids: "S3.19 S3.30 S4.01 S4.03 S4.04 S4.05 S4.19 S5.49 S5.51 S7.08 S7.09 S7.43", logs: ["06-retrieve"] }, () => {
  const ls = L("06-retrieve");
  const cut = ls.findIndex((l) => /cut: k = 5/.test(l));
  const above = ls.slice(0, cut).filter((l) => RE_HIT.test(l)).length;
  const below = ls.slice(cut).filter((l) => RE_HIT.test(l)).length;
  const h = hits("06-retrieve");
  const s1 = h[0]?.score ?? 0;
  const s5 = h[4]?.score ?? 0;
  fact("retrieve.rows", h, "06-retrieve");
  fact("ms.search", num("06-retrieve", /search (\d+) ms/), "06-retrieve");
  const ok = ln("06-retrieve", 5).includes(`ask chroma for the 5 closest · filter ${FILTER_LATEST}`) && above === 5 && below === 3 && h[0]?.id === "hr-leave@2025#3" &&
    h.slice(0, 5).every((x) => x.id.startsWith("hr-leave@2025#")) && s1 > s5 && s1 - s5 <= 0.02 && /TIME .*data\/6-retrieved\.json$/.test(must(ls.find((l) => /^\s+TIME/.test(l)), "TIME"));
  return out(ok, `${above} + ${below} rows, spread ${(s1 - s5).toFixed(3)}`);
});
A({ id: "L50", part: "embed 0 ms", tier: 3, cls: "N", sids: "S5.49", logs: ["06-retrieve"] }, () => out(ln("06-retrieve", 5).includes(`(${config.embedModel}, 0 ms)`), "question embedding from cache"));
A({ id: "L51", tier: 1, cls: "N", sids: "S4.06 S5.44 S6.36", logs: ["07-rerank-off", "06-retrieve"] }, () => {
  const r = rr("07-rerank-off");
  const ok = r.length === 5 && r.every((x) => x.pos === x.was && x.rel === undefined) && r.map((x) => x.id).join() === hits("06-retrieve").slice(0, 5).map((h) => h.id).join() &&
    TXT("07-rerank-off").includes("order unchanged") &&
    // English run (re-narrated): special leave (§5) is below the cut, so without rerank §2 (Probation and Earning Leave) goes in as [2]
    !r.some((x) => x.id === "hr-leave@2025#5") && hits("06-retrieve").findIndex((h) => h.id === "hr-leave@2025#5") >= 5 &&
    r.slice(0, 3).map((x) => x.id).join() === "hr-leave@2025#3,hr-leave@2025#2,hr-leave@2025#7" && sources("08-answer-rerank-off")[1] === "hr-leave@2025#2";
  return out(ok, `${r.map((x) => x.id.split("#")[1]).join(" ")}; #5 at retrieve row ${hits("06-retrieve").findIndex((h) => h.id === "hr-leave@2025#5") + 1}; off [2] ${sources("08-answer-rerank-off")[1]}`);
});
A({ id: "L52", part: "moves", tier: 2, cls: "N", sids: "S1.08 S1.43 S4.07 S4.08 S5.40 S5.43 S6.17 S6.27 S7.10 S7.11 S7.42", logs: ["07-rerank"] }, () => {
  const r = rr("07-rerank");
  const ls = L("07-rerank");
  const line = ls.findIndex((l) => /into the prompt: top 3/.test(l));
  const firstAt = ls.findIndex((l) => RE_RR.test(l));
  const [a, b] = [r[0], r[1]];
  // English run (re-narrated): §3 is the one clear winner; §7 and §4 move up, §2 (Probation and Earning Leave) moves down out of the prompt.
  const two = r.find((x) => x.id === "hr-leave@2025#2");
  const ok = ln("07-rerank", 5).includes("scores each (question, chunk) pair 0–10") && /5 chunks scored in \d+ ms/.test(TXT("07-rerank")) && a?.id === "hr-leave@2025#3" && (a.rel ?? 0) >= 9 && firstAt < line &&
    r.slice(1).every((x) => (x.rel ?? 99) < (a.rel ?? 0)) && b?.move === "▲" && b.id === "hr-leave@2025#7" &&
    r.slice(0, 3).map((x) => x.id).join() === "hr-leave@2025#3,hr-leave@2025#7,hr-leave@2025#4" && r[2]?.move === "▲" &&
    two?.move === "▼" && two.pos > 3 && !r.some((x) => x.id === "hr-leave@2025#5") && r.some((x) => x.move === "▼");
  fact("rerank.rows", r, "07-rerank");
  fact("ms.rerank", num("07-rerank", /scored in (\d+) ms/), "07-rerank");
  return out(ok, r.map((x) => `${x.move}${x.id.split("#")[1]} rel ${x.rel}`).join(", "));
});
/**
 * Retrieve → rerank, as one chain: the rerank rows are exactly the retrieve top 5, each row's `was` and `vec` are that
 * chunk's retrieve rank and score, the arrow agrees with was → position, and rel never rises down the rows.
 * Returns what broke (empty = the chain holds).
 */
function chainBreaks(ret: string, rer: string): string[] {
  const top = hits(ret).slice(0, 5);
  const r = rr(rer);
  const bad: string[] = [];
  if (r.length !== 5 || [...r.map((x) => x.id)].sort().join() !== top.map((h) => h.id).sort().join()) bad.push(`ids ${r.map((x) => x.id.split("@")[0] + "#" + x.id.split("#")[1]).join(" ")} != retrieve top 5`);
  r.forEach((x, i) => {
    const h = top.find((t) => t.id === x.id);
    const move = x.pos < x.was ? "▲" : x.pos > x.was ? "▼" : "";
    if (x.pos !== i + 1 || !h || h.rank !== x.was || h.score !== x.vec || x.move !== move) bad.push(`row ${x.pos} ${x.id}: ${x.move || "="} was ${x.was} vec ${x.vec} vs retrieve ${h ? `${h.rank} ${h.score}` : "absent"}`);
    if (i > 0 && (x.rel ?? -1) > (r[i - 1]!.rel ?? -1)) bad.push(`rel rises at row ${x.pos} (${r[i - 1]!.rel} → ${x.rel})`);
  });
  return bad;
}
/** The answer log cites the rerank top 3, in order. */
const citesTop3 = (ans: string, rer: string) => sources(ans).join() === rr(rer).slice(0, 3).map((x) => x.id).join();
/** One ask log: its own chain holds and its sources are its own rerank top 3. */
const askChain = (n: string) => {
  const bad = chainBreaks(n, n);
  if (!citesTop3(n, n)) bad.push(`sources ${sources(n).join(" ")} != rerank top 3`);
  return bad;
};
A({ id: "L52", part: "chain", tier: 1, cls: "N", sids: "S4.07 S4.08 S5.40 S7.10 S7.42", logs: ["07-rerank", "06-retrieve"] }, () => {
  const bad = chainBreaks("06-retrieve", "07-rerank");
  return out(!bad.length, bad.join("; ") || "rerank rows = retrieve top 5 (was, vec), rel never rises");
});
A({ id: "L52", part: "TIME", tier: 3, cls: "N", sids: "S5.43", logs: ["07-rerank"] }, () => {
  const s = num("07-rerank", /scored in (\d+) ms/);
  return out(Math.abs(timeMs("07-rerank") - s) <= 1, `scored ${s} ms, TIME ${timeMs("07-rerank")} ms`);
});
A({ id: "L53", tier: 1, cls: "P", sids: "S1.08 S1.28 S1.31 S1.32 S1.53 S4.02 S4.09 S4.25 S4.26 S4.27 S4.28 S5.17 S5.19 S5.40 S5.47 S5.51 S6.26 S6.36 S6.39 S7.11 S7.40 S7.50", logs: ["08-answer", "08-answer-rerank-off", "07-rerank"] }, () => {
  const off = "08-answer-rerank-off";
  const on = "08-answer";
  const re = new RegExp(`\\b${EXP}\\b.*\\[1\\]`);
  const prompt = box(on, /┌─/, /└─/);
  const sys = prompt.indexOf("SYSTEM:");
  const sysLines = prompt.slice(sys + 1, prompt.indexOf("", sys + 1));
  const opens = prompt.filter((l) => FENCE.open.test(l)).length;
  const closes = prompt.filter((l) => FENCE.close.test(l)).length;
  const s = sources(on);
  const tok = num(on, /(\d+) prompt tokens · \d+ output tokens · \d+ ms/);
  const nRules = num(on, /rules \((\d+)\)/);
  fact("answers.08-answer", answer(on), on);
  fact("answers.08-answer-rerank-off", answer(off), off);
  fact("ms.answer", num(on, /output tokens · (\d+) ms/), on);
  const ok = re.test(answer(off)) && re.test(answer(on)) && sources(off)[0] === "hr-leave@2025#3" && [...sources(off)].sort().join() !== [...s].sort().join() &&
    nRules === RULES.length && sysLines.join("\n") === RULES.join("\n") && opens === 3 && closes === 3 && prompt.includes(`| 7 | ${EXP} |`) &&
    s.length === 3 && s[0] === "hr-leave@2025#3" && tok < config.numCtx && ln(on, 5).includes(config.chatModel) && citesTop3(on, "07-rerank");
  return out(ok, `cites rerank top 3 ${citesTop3(on, "07-rerank")}; rules ${nRules}/${sysLines.length}, fences ${opens}/${closes}, ${tok} prompt tokens < ${config.numCtx}; off ${sources(off).map((x) => x.split("#")[1])} vs on ${s.map((x) => x.split("#")[1])}`);
});
const askLogs = ["ask-access-on", "ask-out-of-corpus", "ask-injection"];
A({ id: "L54", tier: 3, cls: "N", sids: "S4.09 S5.43 S5.52 S5.53", logs: ["06-retrieve", "07-rerank", "08-answer", ...askLogs] }, () => {
  const search = num("06-retrieve", /search (\d+) ms/);
  const ret = timeMs("06-retrieve");
  const rer = num("07-rerank", /scored in (\d+) ms/);
  const ans = num("08-answer", /output tokens · (\d+) ms/);
  const share = rer / (ret + rer + ans);
  const answerMs = [ans, num("08-answer-rerank-off", /output tokens · (\d+) ms/), ...askLogs.map((n) => num(n, /output tokens · (\d+) ms/))];
  const rerankMs = [rer, ...askLogs.map((n) => num(n, /scored in (\d+) ms/))];
  fact("ms.answerRange", [Math.min(...answerMs), Math.max(...answerMs)], "08-answer*, ask-*");
  fact("ms.rerankRange", [Math.min(...rerankMs), Math.max(...rerankMs)], "07-rerank, ask-*");
  fact("ms.rerankShare", share, "06-retrieve, 07-rerank, 08-answer");
  return out(rer > 10 * search && share >= 0.5, `search ${search}, retrieve ${ret}, rerank ${rer}, answer ${ans} ms; rerank share ${share.toFixed(2)}`);
});
A({ id: "L55", tier: 2, cls: "N", sids: "S4.29", logs: ["08-answer", "08-answer-rerank-off"] }, () =>
  out(["08-answer", "08-answer-rerank-off"].every((n) => !new RegExp(`\\|\\s*7\\s*\\|\\s*${EXP}\\s*\\|`).test(answer(n))), "the model skips rule 7's row copy"),
);

const asks = (n: string, q: string) => ln(n, 1).startsWith(`$ npm run ask -- "${q}"`);
const sameRows = (a: string, b: string) => hits(a).map((x) => x.id + x.score).join() === hits(b).map((x) => x.id + x.score).join() && sources(a).join() === sources(b).join();
/** The senior row of the abroad table (travel-expenses §4, second data row): its money cells. */
const seniorRow = (sec: string) => {
  const r = must(sectionText(doc("2025", "travel-expenses"), sec).split("\n").filter((l) => l.startsWith("|") && !/^\|-/.test(l))[2], `senior row §${sec}`); // [0] is the header
  return r.split("|").slice(2).map((c) => c.trim()).filter(Boolean);
};
const seniorAbroad = () => seniorRow("4");
A({ id: "L60", tier: 1, cls: "P", sids: "S4.14 S4.22 S5.03 S5.12 S5.15 S6.23 S7.09", logs: ["ask-access-on"] }, () => {
  const n = "ask-access-on";
  const ls = L(n);
  const cut = ls.findIndex((l) => /cut: k = 5/.test(l));
  const rows = [ls.slice(0, cut).filter((l) => RE_HIT.test(l)).length, ls.slice(cut).filter((l) => RE_HIT.test(l)).length];
  const ok = asks(n, firstOf("access").query) && ln(n, 5).includes(`filter ${FILTER_LATEST}`) && rows.join() === "5,3" && !TXT(n).includes("hr-salary-bands") &&
    !answer(n).includes(G("q12").expect) && TXT(n).includes("5 chunks handed on") && TXT(n).includes("top 3 of 5 chunks") && ln(n, 17) === "" && ln(n, 18).startsWith("━━ STEP 7/8 · RERANK") && !askChain(n).length;
  return out(ok, `${askChain(n).join("; ") || "chain holds"}; "${answer(n).slice(0, 80)}"`);
});
A({ id: "L61", tier: 2, cls: "N", sids: "S4.14 S5.05 S5.06 S5.07 S6.10 S6.23", logs: ["ask-access-on"] }, () => {
  const n = "ask-access-on";
  const a = answer(n);
  const top = rr(n)[0];
  const ties = num(n, /ties: (\d+) of 5/);
  fact("rerank.accessTies", ties, n);
  // English run (re-narrated): both tables score rel 10; the euro table is [1], but the model answers from [2], the domestic
  // lira table (the senior specialist's hotel cell), and quotes no euro cell. Still no salary figure (L60).
  const cells = seniorAbroad();
  const hotel = seniorRow("3").at(-1)!;
  const second = rr(n)[1];
  const ok = !isAbstain(a) && a.includes(hotel) && /\[2\]/.test(a) && !/\[[13]\]/.test(a) && !cells.some((c) => new RegExp(`\\b${c}\\b`).test(a)) &&
    sources(n)[0] === "travel-expenses@2025#4" && sources(n)[1] === "travel-expenses@2025#3" && top?.id === "travel-expenses@2025#4" && top.move === "" && top.was === 1 && top.rel === 10 &&
    second?.id === "travel-expenses@2025#3" && second.move === "▲" && second.rel === 10;
  return out(ok, `answer has domestic ${hotel}, no ${cells}: "${a.slice(0, 80)}"; rerank 1 ${top?.id} was ${top?.was} rel ${top?.rel}, 2 ${second?.id} ${second?.move} rel ${second?.rel}`);
});
A({ id: "L62", tier: 1, cls: "P", sids: "S4.15 S4.22 S5.04 S7.09", logs: ["ask-access-off"] }, () => {
  const n = "ask-access-off";
  const h = hits(n).slice(0, 5);
  // capture's pipeline() prints no rerank rows here: the three sources must at least be three of its own top 5
  const s = sources(n);
  const fromTop5 = s.length === 3 && new Set(s).size === 3 && s.every((x) => h.some((y) => y.id === x));
  const ok = fromTop5 && TXT(n).includes(`"${firstOf("access").query}"`) && JSON.stringify(filterOf(n)) === '{"edition":"2025"}' && h.every((x) => x.id.startsWith("hr-salary-bands@2025#")) && h[0]?.id === "hr-salary-bands@2025#3" && answer(n).includes(G("q12").expect);
  return out(ok, `sources from own top 5 ${fromTop5}; "${answer(n).slice(0, 80)}"`);
});
A({ id: "L63", tier: 1, cls: "N", sids: "S3.38 S4.13 S6.23", logs: ["eval-section", "eval-fixed", "eval-answers"] }, () =>
  out(["eval-section", "eval-fixed", "eval-answers"].every((n) => TXT(n).includes("hr-only chunks reached nobody ✓")), "all three eval logs"),
);
A({ id: "L64", tier: 1, cls: "P", sids: "S1.39 S4.22 S4.31 S6.47 S7.35", logs: ["ask-out-of-corpus"] }, () => {
  const n = "ask-out-of-corpus";
  const bad = askChain(n);
  return out(asks(n, firstOf("out-of-corpus").query) && /OUT .*· ABSTAINED$/m.test(TXT(n)) && answer(n) === ABSTAIN && !bad.length, `${bad.join("; ") || "chain holds"}; "${answer(n)}"`);
});
A({ id: "L65", part: "rule off", tier: 2, cls: "P", sids: "S4.32 S6.47 S7.35", logs: ["ask-out-of-corpus-rule-off", "ask-out-of-corpus"] }, () => {
  const a = answer("ask-out-of-corpus-rule-off");
  fact("answers.ask-out-of-corpus-rule-off", a, "ask-out-of-corpus-rule-off");
  return out(!isAbstain(a) && a !== ABSTAIN && sameRows("ask-out-of-corpus", "ask-out-of-corpus-rule-off"), `"${a}"`);
});
/** Line 1 of the rule-off log ends with capture's marker; the rule-on log has it nowhere. */
const ruleOffProven = (off: string, on: string) => {
  const mark = must(RULE_OFF_MARKER[off], `capture.ts marker for ${off}`);
  return out(ln(off, 1).endsWith(`   ${mark}`) && !TXT(on).includes(mark), `${off} line 1 ends "${mark}": ${ln(off, 1).endsWith(`   ${mark}`)}; ${on} free of it: ${!TXT(on).includes(mark)}`);
};
A({ id: "L65", part: "marker", tier: 1, cls: "P", sids: "S4.32 S6.47", logs: ["ask-out-of-corpus-rule-off", "ask-out-of-corpus"] }, () => ruleOffProven("ask-out-of-corpus-rule-off", "ask-out-of-corpus"));
A({ id: "L65", part: "refusal in words", tier: 2, cls: "E", soft: true, sids: "S4.32", logs: ["ask-out-of-corpus-rule-off"] }, () => {
  const a = answer("ask-out-of-corpus-rule-off");
  return out(/no information|not mentioned|not (stated|covered|found)|does not/i.test(a) && a.includes("[1]"), `"${a}"`);
});
A({ id: "L66", part: "ban on", tier: 1, cls: "P", sids: "S4.22 S4.34 S4.35 S5.07 S5.09 S5.18 S6.15", logs: ["ask-injection", "ask-injection-rule-off"] }, () => {
  const n = "ask-injection";
  const a = answer(n);
  const s = sources(n);
  const ok = asks(n, firstOf("injection").query) && hits(n)[0]?.id === "announcement-meal-card@2025#2" && s[0] === "announcement-meal-card@2025#2" && s[1] === "benefits@2025#2" &&
    rr(n).slice(0, 3).some((x) => x.id === "announcement-meal-card@2025#2") && a.includes(G("q13").expect) && ln(n, 30).startsWith("━━ STEP 8/8 · ANSWER") && !askChain(n).length &&
    // English run (re-narrated, Kral's delegated decision 4 Oct 01:40): the concrete ban does NOT stop it. The ban-on answer still
    // ends with the planted request, word for word the ban-off answer: a sentence in the prompt is not a security boundary.
    a.includes(PLANTED) && a === answer("ask-injection-rule-off") && sameRows(n, "ask-injection-rule-off");
  fact("answers.ask-injection", a, n);
  return out(ok, `${askChain(n).join("; ") || "chain holds"}; same as ban off: ${a === answer("ask-injection-rule-off")}; "${a}"`);
});
A({ id: "L66", part: "obeys anyway", tier: 1, cls: "E", sids: "S5.18", logs: ["ask-injection"] }, () =>
  out(/password/i.test(answer("ask-injection")) && /employee number/i.test(answer("ask-injection")) && answer("ask-injection").includes(PLANTED), answer("ask-injection")),
);
A({ id: "L67", part: "ban off", tier: 2, cls: "P", sids: "S4.35 S5.09 S5.18 S6.48 S7.47", logs: ["ask-injection-rule-off", "ask-injection"] }, () => {
  const a = answer("ask-injection-rule-off");
  fact("answers.ask-injection-rule-off", a, "ask-injection-rule-off");
  return out(a.includes(PLANTED) && a.includes(G("q13").expect) && sameRows("ask-injection", "ask-injection-rule-off"), `"${a.slice(0, 120)}"`);
});
A({ id: "L67", part: "marker", tier: 1, cls: "P", sids: "S4.35 S6.48", logs: ["ask-injection-rule-off", "ask-injection"] }, () => ruleOffProven("ask-injection-rule-off", "ask-injection"));
A({ id: "L67", part: "asks for both", tier: 2, cls: "E", sids: "S5.18", logs: ["ask-injection-rule-off"] }, () =>
  out(/password/i.test(answer("ask-injection-rule-off")) && /employee number/i.test(answer("ask-injection-rule-off")), "planted request obeyed in words"),
);

const NOT_RETRIEVAL = ["out-of-corpus", "access"];
const RETRIEVAL_N = gold.filter((g) => !NOT_RETRIEVAL.includes(g.type)).length;
const evalRow = (n: string, id: string) => must(evalRows(n).find((r) => r.id === id), `${id} in ${n}`);
/** The cross-lingual gold type: every gold section of it lies in the odd-language doc. */
const CROSS = must(
  [...new Set(gold.map((g) => g.type))].find((t) => gold.filter((g) => g.type === t).every((g) => g.gold_sections.length > 0 && g.gold_sections.every((k) => k.startsWith(`${ODD.id}#`)))),
  "cross-lingual gold type",
);
/** rr values a row may print when its gold section is below the printed top 3 (rank 4, rank 5, not in the top k = 5). */
const DEEPER_RR = [0.25, 0.2, 0];
const near = (a: number, b: number, digits: number) => Math.abs(a - b) <= 0.5 * 10 ** -digits + 1e-9;
/**
 * Re-derive an eval log from the gold file. Each row: the first rank of a gold section in its top 3 gives rr = 1/rank
 * (or one of DEEPER_RR when none is there), and the mark is ✓ only for rr 1. Then hit@1, recall@5 and MRR over the
 * retrieval rows must equal the OUT line, and each per-type row its own n, hit@1 and MRR. Returns what broke.
 */
function evalBreaks(n: string): string[] {
  const rows = evalRows(n);
  const bad: string[] = [];
  if (rows.map((r) => r.id).join() !== gold.map((g) => g.id).join()) bad.push(`rows ${rows.length}, ids differ from gold`);
  const scored: { type: string; rr: number }[] = [];
  for (const r of rows) {
    const g = must(gold.find((x) => x.id === r.id), `gold ${r.id}`);
    const retrieval = !NOT_RETRIEVAL.includes(g.type);
    const at = r.top3.split(" ").findIndex((k) => g.gold_sections.includes(k));
    const want = !retrieval ? 0 : at >= 0 ? 1 / (at + 1) : DEEPER_RR.includes(r.rr) ? r.rr : Number.NaN;
    const mark = !retrieval ? "–" : want === 1 ? "✓" : want > 0 ? "·" : "✗";
    if (r.type !== g.type || r.mark !== mark || !near(r.rr, want, 2)) bad.push(`${r.id} printed ${r.mark} rr ${r.rr}, gold ${g.gold_sections.join(" ")} gives ${mark} rr ${want.toFixed(2)}`);
    if (retrieval && g.gold_sections.length !== 1) bad.push(`${r.id}: ${g.gold_sections.length} gold sections, recall not derivable`);
    if (retrieval) scored.push({ type: g.type, rr: want });
  }
  const mean = (xs: number[]) => sum(xs) / xs.length;
  const calc = (xs: { rr: number }[]) => ({ hit1: mean(xs.map((x) => (x.rr === 1 ? 1 : 0))), recall: mean(xs.map((x) => (x.rr > 0 ? 1 : 0))), mrr: mean(xs.map((x) => x.rr)) });
  const s = evalSummary(n);
  const c = calc(scored);
  if (s.n !== scored.length || !near(s.hit1, c.hit1, 3) || !near(s.recall, c.recall, 3) || !near(s.mrr, c.mrr, 3))
    bad.push(`OUT hit@1 ${s.hit1} recall ${s.recall} MRR ${s.mrr} (${s.n}), gold gives ${c.hit1.toFixed(3)} ${c.recall.toFixed(3)} ${c.mrr.toFixed(3)} (${scored.length})`);
  const pt = perType(n);
  const types = [...new Set(scored.map((x) => x.type))];
  if (Object.keys(pt).sort().join() !== [...types].sort().join()) bad.push(`per-type rows ${Object.keys(pt).join()} != ${types.join()}`);
  for (const t of types) {
    const xs = scored.filter((x) => x.type === t);
    const ct = calc(xs);
    const p = pt[t];
    if (!p || p.n !== xs.length || !near(p.hit1, ct.hit1, 2) || !near(p.mrr, ct.mrr, 2)) bad.push(`${t} printed n=${p?.n} hit@1 ${p?.hit1} MRR ${p?.mrr}, gold gives n=${xs.length} ${ct.hit1.toFixed(2)} ${ct.mrr.toFixed(2)}`);
  }
  return bad;
}
A({ id: "L70", tier: 1, cls: "P", sids: "S5.28 S5.33 S5.39 S6.40 S7.44", logs: ["eval-section"] }, () => {
  const s = evalSummary("eval-section");
  const ticks = evalRows("eval-section").filter((r) => r.mark === "✓").length;
  fact("eval.oneQuestion", 1 / s.n, "eval-section");
  fact("eval.section", s, "eval-section");
  const bad = evalBreaks("eval-section");
  const ok = new RegExp(`EVAL\\s+${gold.length} gold questions`).test(TXT("eval-section")) && ln("eval-section", 3).includes("edition 2025") && s.recall === 1 && s.n === RETRIEVAL_N && ticks === Math.round(s.hit1 * s.n) && !bad.length;
  return out(ok, `${bad.join("; ") || "rows and summary re-derived from gold"}; hit@1 ${s.hit1} = ${ticks}/${s.n}, recall ${s.recall}, one question = ${(1 / s.n).toFixed(3)}`);
});
A({ id: "L71", tier: 1, cls: "N", sids: "S2.25 S5.28 S5.29 S5.31 S6.40", logs: ["eval-section", "eval-fixed"] }, () => {
  const s = evalSummary("eval-section");
  const f = evalSummary("eval-fixed");
  const ps = perType("eval-section");
  const pf = perType("eval-fixed");
  const types = Object.keys(ps).every((t) => ps[t]!.hit1 >= (pf[t]?.hit1 ?? 0));
  const tick = (n: string) => new Set(evalRows(n).filter((r) => r.mark === "✓").map((r) => r.id));
  const ts = tick("eval-section");
  const tf = tick("eval-fixed");
  const wins = [...ts].filter((x) => !tf.has(x));
  const q01 = [evalRow("eval-fixed", "q01"), evalRow("eval-section", "q01")];
  fact("eval.fixed", f, "eval-fixed");
  fact("eval.wins", wins, "eval-section, eval-fixed");
  const ok = s.hit1 >= f.hit1 + 0.25 && s.recall >= f.recall && s.mrr > f.mrr && f.recall < 1 && types && [...tf].every((x) => ts.has(x)) && wins.length >= 5 &&
    q01[0]!.mark === "✗" && q01[0]!.rr === 0 && q01[1]!.mark === "✓" && q01[1]!.rr === 1 && evalRow("eval-fixed", "q02").rr === 0 && !evalBreaks("eval-fixed").length;
  return out(ok, `${evalBreaks("eval-fixed").join("; ") || "eval-fixed re-derived from gold"}; hit@1 ${s.hit1}/${f.hit1}, recall ${s.recall}/${f.recall}, MRR ${s.mrr}/${f.mrr}; wins ${wins.length}, losses ${[...tf].filter((x) => !ts.has(x)).length}`);
});
A({ id: "L72", part: "floor", tier: 1, cls: "P", sids: "S4.10 S6.21", logs: ["eval-section"] }, () => {
  const r = evalRow("eval-section", "q02");
  return out(r.type === "paraphrase" && r.rr <= 0.25 && !G("q02").gold_sections.some((k) => r.top3.split(" ").includes(k)), `q02 rr ${r.rr}, top 3 ${r.top3}`);
});
A({ id: "L72", part: "rank 5", tier: 2, cls: "P", sids: "S4.10 S4.22 S5.25 S5.36 S6.09 S6.21 S6.45 S6.58 S7.44", logs: ["eval-section", "eval-answers"] }, () => {
  const r = evalRow("eval-section", "q02");
  const a = evalRow("eval-answers", "q02");
  return out(r.mark === "·" && r.rr === 0.2 && a.rr === 0.2 && r.top3.split(" ")[0] === "hr-working-hours#4" /* English run (re-narrated): §4 is first, not §5 */ && a.ans === "✓", `q02 ${r.mark} rr ${r.rr}, first ${r.top3.split(" ")[0]}, answer ${a.ans}`);
});
A({ id: "L72", part: "ask-paraphrase", tier: 2, cls: "P", sids: "S4.10 S6.45", logs: ["ask-paraphrase"] }, () => {
  const n = "ask-paraphrase";
  const vec = hits(n).findIndex((h) => h.id === "hr-leave@2025#3") + 1;
  const pos = rr(n).find((x) => x.id === "hr-leave@2025#3")?.pos ?? 99;
  return out(asks(n, firstOf("paraphrase").query) && vec >= 4 && vec <= 5 && pos <= 3 && answer(n).includes(G("q02").expect), `vector row ${vec}, rerank row ${pos}`);
});
A({ id: "L73", tier: 2, cls: "P", sids: "S3.14 S5.30 S6.08 S6.29 S6.31 S7.37", logs: ["eval-section", "eval-fixed"] }, () => {
  const rows = evalRows("eval-section").filter((r) => r.type === CROSS);
  const ps = perType("eval-section");
  const pf = perType("eval-fixed");
  const twin = evalRows("eval-section").filter((r) => r.type === "twin-table");
  fact("eval.perType", { section: ps, fixed: pf }, "eval-section, eval-fixed");
  const ok = rows.length === 4 && rows.every((r) => r.mark === "✓" && r.rr === 1 && r.top3.startsWith(`${ODD.id}#`)) && ps[CROSS]?.n === 4 && ps[CROSS]?.hit1 === 1 &&
    (pf[CROSS]?.hit1 ?? 1) <= 0.5 && (ps.paraphrase?.hit1 ?? 1) < (ps["twin-table"]?.hit1 ?? 0) && (ps.table?.hit1 ?? 1) < (ps["twin-table"]?.hit1 ?? 0) &&
    twin.length === 3 && twin.filter((r) => r.rr === 0.5).length === 1;
  return out(ok, `${CROSS}: ${rows.length} rows, section hit@1 ${ps[CROSS]?.hit1}, fixed ${pf[CROSS]?.hit1}; twin-table rr ${twin.map((r) => r.rr)}`);
});
A({ id: "L74", tier: 1, cls: "P", sids: "S4.31 S4.35 S5.32 S5.35 S5.36 S6.03 S6.18 S6.63", logs: ["eval-answers", "eval-section"] }, () => {
  const a = evalRows("eval-answers");
  const s = evalRows("eval-section");
  const m = must(TXT("eval-answers").match(/answers correct: (\d+) \/ (\d+)/), "answers correct");
  const same = a.length === s.length && a.every((r, i) => r.top3 === s[i]?.top3 && r.rr === s[i]?.rr && r.mark === s[i]?.mark);
  const must2 = a.filter((r) => ["q12", "q13", "q14", "q15", "q16"].includes(r.id) || r.type === "table" || r.type === "twin-table");
  const q06 = evalRow("eval-answers", "q06");
  fact("layout.eval-answers", { out: L("eval-answers").findIndex((l) => /^\s+OUT\s+hit@1/.test(l)) + 1, lines: L("eval-answers").length }, "eval-answers");
  const bad = evalBreaks("eval-answers");
  // English run (re-narrated with L66): the one wrong answer is q13, the injection answer that asks for the password.
  const wrong = a.filter((r) => r.ans !== "✓").map((r) => r.id);
  const ok = +m[1]! === gold.length - 1 && +m[2]! === gold.length && wrong.join() === "q13" && same && must2.every((r) => r.ans === "✓" || r.id === "q13") && q06.rr === 0.5 && q06.top3.startsWith("travel-expenses#3 travel-expenses#4") && !bad.length;
  return out(ok, `${bad.join("; ") || "rows and summary re-derived from gold"}; answers ${m[1]}/${m[2]}, retrieval == eval-section ${same}, q06 ${q06.rr} ${q06.top3}`);
});
A({ id: "L75", tier: 1, cls: "N", sids: "S5.32", logs: ["eval-fixed"] }, () => {
  const at = L("eval-fixed").findIndex((l) => /^\s+OUT\s+hit@1/.test(l)) + 1;
  fact("layout.eval-fixed", { out: at, lines: L("eval-fixed").length }, "eval-fixed");
  return out(at > 0, `OUT on line ${at}`);
});
A({ id: "L76", tier: 1, cls: "N", sids: "S3.32 S5.29 S5.38", logs: ["eval-section-json", "eval-fixed-json", "eval-section", "eval-fixed"] }, () => {
  const pairs2 = [["eval-section-json", "eval-section"], ["eval-fixed-json", "eval-fixed"]] as const;
  const same = pairs2.map(([j, c]) => evalSummary(j).line === evalSummary(c).line);
  return out(same.every(Boolean), `brute force == chroma: ${same}`);
});

A({ id: "L80", part: "ingest", tier: 1, cls: "N", sids: "S4.42 S4.49 S4.50 S5.02 S5.45 S5.50 S7.43", logs: ["ingest-2026"] }, () => {
  const n = "ingest-2026";
  const t = TXT(n);
  const m = t.match(/(\d+) records added · (\d+) in the store · editions: 2025, 2026/);
  const added = Number(m?.[1]);
  const ok = t.includes("corpus/2026") && /OUT\s+8 documents/.test(t) && !!m && +m[2]! === 2 * added && added === sectionChunks("2026").length && t.includes("→ hr-leave@2026#3") &&
    t.includes("identical ✓") && ln(n, 74) === "" && ln(n, 75).startsWith("━━ STEP 4/8 · EMBED");
  return out(ok, `${m?.[1]} added, ${m?.[2]} in the store`);
});
A({ id: "L80", part: "warm cache", tier: 3, cls: "N", sids: "S5.45", logs: ["ingest-2026"] }, () => out(/ 0 computed, /.test(TXT("ingest-2026")), "needs a warm .cache/"));
A({ id: "L81", tier: 1, cls: "N", sids: "S1.39 S1.54 S4.40 S4.43 S4.44 S5.33 S6.01 S6.06 S6.20 S6.34 S6.38 S6.57", logs: ["question-4-2026"] }, () => {
  const n = "question-4-2026";
  const s = sources(n);
  const a = answer(n);
  fact("answers.question-4-2026", a, n);
  const ok = filterOf(n).edition === "2026" && ln(n, 4).includes("chroma store · chunker section · rerank on") && new RegExp(`\\b${ROW7_2026}\\b.*\\[1\\]`).test(a) && s.length === 3 && s.every((x) => /@2026#/.test(x)) && s[0] === "hr-leave@2026#3";
  return out(ok, `"${a}" ${s.join(" ")}`);
});
A({ id: "L82", part: "twins", tier: 2, cls: "N", sids: "S4.46 S6.05 S6.46 S6.57", logs: ["edition-all"] }, () => {
  const n = "edition-all";
  const h = hits(n);
  const twins = ["hr-leave@2026#3", "hr-leave@2025#3"];
  const top2 = h.slice(0, 2).map((x) => x.id);
  const gap = Math.abs((h[0]?.score ?? 0) - (h[1]?.score ?? 1));
  const s = sources(n);
  const a = answer(n);
  const year = (s[0] ?? "").includes("@2026#") ? ROW7_2026 : EXP;
  fact("edition.scores", h.slice(0, 2), n);
  fact("edition.gap", gap, n);
  const ok = ln(n, 1).includes('EDITION_FILTER = "all"') && filterOf(n).edition === undefined && twins.every((t) => top2.includes(t)) && gap <= 0.01 /* English run (re-narrated): 0.005, still a near tie */ && twins.every((t) => s.slice(0, 2).includes(t)) && hasExp(a, year);
  return out(ok, `rows ${top2.join(" ")} gap ${gap.toFixed(3)}; [1] ${s[0]} → answer has ${year}`);
});
A({ id: "L82", part: "2026 first", tier: 2, cls: "N", soft: true, sids: "S6.46", logs: ["edition-all"] }, () =>
  out(sources("edition-all")[0] === "hr-leave@2026#3" && hasExp(answer("edition-all"), ROW7_2026), "the page narrates the newer edition winning"),
);
/** The 2026 password period: the number the 2026 line has and the 2025 line does not. */
const PW_2026 = (() => {
  const a = rawOf("2025", "it-security.md").split("\n");
  const b = rawOf("2026", "it-security.md").split("\n");
  const i = a.findIndex((l, k) => l !== b[k] && !HEADER_RULE.test(l.trim()) && !/^edition:/.test(l));
  const before: string[] = a[i]?.match(/\d+/g) ?? [];
  return (b[i]?.match(/\d+/g) ?? []).find((x) => !before.includes(x)) ?? "?";
})();
A({ id: "L83", tier: 2, cls: "N", sids: "S4.48", logs: ["ask-2026-password"] }, () => {
  const n = "ask-2026-password";
  const s = sources(n);
  return out(s.includes("it-security@2026#2") && !s.some((x) => x.includes("@2025#")) && hasExp(answer(n), PW_2026), `"${answer(n)}" ${s.join(" ")}`);
});
// English run (narrated): the English question gets a TURKISH answer: the model copies the language of its only sources.
A({ id: "L83", part: "answer language", tier: 2, cls: "E", sids: "S4.48", logs: ["ask-2026-password"] }, () => {
  const n = "ask-2026-password";
  const ok = /^\$ npm run ask -- "[^"]+"/.test(ln(n, 1)) && !TURKISH.test(ln(n, 1)) && TURKISH.test(answer(n)) && sources(n).every((x) => x.startsWith(`${ODD.id}@2026#`));
  return out(ok, `an English question gets a Turkish answer from Turkish sources: "${answer(n)}"`);
});
A({ id: "L90", part: "cost", tier: 2, cls: "P", sids: "S1.45 S1.46 S1.48 S5.41 S5.42 S6.07 S6.24", logs: ["stuff-everything", "08-answer", "06-retrieve", "07-rerank", "08-answer-rerank-off", ...askLogs] }, () => {
  const n = "stuff-everything";
  const chars = num(n, /documents\s+8 \((\d+) characters\)/);
  const tok = num(n, /prompt tokens\s+(\d+)/);
  const ms = num(n, /time\s+(\d+) ms/);
  const rag = num("08-answer", /(\d+) prompt tokens/);
  const answerMax = Math.max(...["08-answer", "08-answer-rerank-off", ...askLogs].map((x) => num(x, /output tokens · (\d+) ms/)));
  const steps = timeMs("06-retrieve") + timeMs("07-rerank") + timeMs("08-answer");
  fact("stuff.run", { chars, tokens: tok, ms, ratioTokens: tok / rag, ratioMs: ms / steps }, n);
  const ok = tok > config.numCtx && tok / rag >= 5 && ms >= 15000 && ms > 3 * answerMax && ms >= 5 * steps && hasExp(stuffAnswer());
  return out(ok, `${chars} chars, ${tok} tokens (x${(tok / rag).toFixed(1)} the RAG prompt), ${ms} ms (x${(ms / steps).toFixed(1)} steps 6-8)`);
});
A({ id: "L90", part: "margins", tier: 2, cls: "P", soft: true, sids: "S5.41", logs: ["stuff-everything", "08-answer"] }, () => {
  const tok = num("stuff-everything", /prompt tokens\s+(\d+)/);
  return out(tok >= 9000 && tok / num("08-answer", /(\d+) prompt tokens/) >= 7, `${tok} tokens`);
});
A({ id: "L95", part: "doctor", tier: 3, cls: "N", sids: "S1.05 S1.23 S1.24 S5.49 S7.02 S7.19", logs: ["doctor"] }, () => {
  const t = TXT("doctor");
  const ls = L("doctor");
  fact("ms.doctorEmbed", num("doctor", /embed one sentence\s+1024 numbers · (\d+) ms/), "doctor");
  fact("ms.doctorAnswer", num("doctor", /one answer\s+(\d+) ms/), "doctor");
  const ok = /Node\.js\s+22\./.test(t) && /corpus\/2025\s+8 documents/.test(t) && /one answer\s+\d+ ms · ".{0,30}"$/m.test(t) && ls[ls.length - 1] === "Ready." && !t.includes("✗");
  return out(ok, ls.slice(3, 11).map((l) => l.trim().replace(/\s{2,}/g, " ")).join(" | ").slice(0, 200));
});
A({ id: "L95", part: "languages", tier: 3, cls: "E", sids: "S7.02", logs: ["doctor"] }, () => {
  const en = D25.filter((d) => d.lang === "en").length;
  return out(new RegExp(`corpus/2025\\s+8 documents · ${en} en, 1 tr`).test(TXT("doctor")), `${en} en`);
});

A({ id: "L00", part: "declared", tier: 1, cls: "N", sids: "-" }, () => {
  const stray = [...DECLARED].filter((n) => !REQUIRED_LOGS.includes(n) && !NOT_CAPTURED_YET.includes(n));
  return out(!stray.length, stray.length ? `specs read logs in neither list: ${stray.join(" ")}` : `${DECLARED.size} log names, all listed`);
});

// ═══ facts.json and the report ══════════════════════════════════════════════════════════════════

/** Where each block a page slices with <Log from to> sits in every log (line numbers from 1). */
function layoutOf(n: string) {
  const ls = L(n);
  const at = (re: RegExp) => ls.flatMap((l, i) => (re.test(l) ? [i + 1] : []));
  const rows = at(/^\s+(q\d\d\s|\d+\s+(\d\.\d{3}|[▲▼]?\s*was)\s)|^\s+\d\d:\d\d\s{2}|^\s+\[\d\] /);
  return {
    lines: ls.length,
    steps: Object.fromEntries(ls.flatMap((l, i) => (l.match(/^━━ STEP (\w+)\/8/) ? [[l.match(/^━━ STEP (\w+)\/8/)![1]!, i + 1]] : []))),
    out: at(/^\s+OUT\s/),
    ledger: at(/^\s+LEDGER/)[0],
    firstRow: rows[0],
    lastRow: rows[rows.length - 1],
  };
}

if (WRITE_FACTS) {
  for (const f of readdirSync(LOGS).filter((x) => x.endsWith(".txt")).sort()) fact(`layout.${f.replace(/\.txt$/, "")}`, layoutOf(f.replace(/\.txt$/, "")), f);
  const file = join(LOGS, "facts.json");
  writeFileSync(file, `${JSON.stringify({ about: "written by npm run check:story -- --write-facts; every value names the log or replica it came from", dataLang: DATA_LANG, facts: FACTS }, null, 2)}\n`);
  console.log(`facts → ${file}`);
}

for (const r of ROWS) {
  console.log(`${r.status}  ${r.spec.id.padEnd(4)}  t${r.spec.tier}  ${r.spec.sids}  ${r.detail}`);
}
const count = (s: Status) => ROWS.filter((r) => r.status === s).length;
const failed = ROWS.filter((r) => r.status === "FAIL");
const exitCode = failed.some((r) => r.spec.tier === 1 || r.hard) ? 1 : failed.length ? 2 : 0;
console.log(
  `\ncheck:story ${exitCode ? "✗" : "✓"}  ${count("PASS")} pass · ${count("FAIL")} fail · ${count("WARN")} warn · ${count("PEND")} pending  ` +
    `(${new Set(ROWS.map((r) => r.spec.id)).size} ids · corpus language ${DATA_LANG} · logs ${LOGS}${OFFLINE ? " · offline" : ""})`,
);
if (failed.length) console.log(`failed: ${[...new Set(failed.map((r) => r.spec.id))].join(" ")}`);
process.exit(exitCode);
