// STEP 1 — LOAD
// Gate: the model has never seen these files. Before anything else, read them — and read what each
// file says ABOUT itself: which document it is, which edition, who may see it.
//
// In real life this is the PDF/Word extraction step. Our corpus is already text, but it looks the way
// extracted text looks: page headers, page numbers, lines broken mid-sentence. Step 2 deals with that.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../lib/config.js";
import { hashOf, writeStep } from "../lib/data.js";
import { done, line, more, stepHeader } from "../lib/log.js";
import type { Doc, DocMeta } from "../lib/types.js";

const KEYS: (keyof DocMeta)[] = ["id", "title", "edition", "department", "access", "lang"];

/**
 * Split a file into its front matter (the `---` block on top) and its body.
 * Only `key: value` lines are supported — enough for our metadata, no YAML library needed.
 * @param raw the whole file, line endings already normalised to \n
 * @example parseFrontMatter('---\nid: hr-leave\nedition: "2025"\n---\nbody').meta.edition // "2025"
 */
export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const l of m[1]!.split("\n")) {
    const kv = l.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["'](.*)["']$/, "$1");
  }
  return { meta, body: m[2]! };
}

/** Every file in corpus/<edition>/, in a stable order. Windows line endings become \n here, once. */
async function readEditionFiles(edition: string): Promise<{ path: string; raw: string }[]> {
  const dir = join("corpus", edition);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    throw new Error(`No folder ${dir}. Editions live in corpus/<edition>/ — try --edition 2025`);
  }
  return Promise.all(
    names.map(async (n) => ({ path: join(dir, n), raw: (await readFile(join(dir, n), "utf8")).replace(/\r\n/g, "\n") })),
  );
}

/** Fingerprint of an edition's files — step 2 uses it to notice that the corpus changed. */
export async function corpusHash(edition: string): Promise<string> {
  return hashOf(await readEditionFiles(edition));
}

/**
 * Read one edition of the corpus.
 * @param edition folder name under corpus/, e.g. "2025"
 * @returns one Doc per file: metadata from the front matter, body untouched
 */
export async function loadCorpus(edition: string): Promise<Doc[]> {
  const files = await readEditionFiles(edition);
  return files.map(({ path, raw }) => {
    const { meta, body } = parseFrontMatter(raw);
    const missing = KEYS.filter((k) => !meta[k]);
    if (missing.length) throw new Error(`${path}: front matter is missing ${missing.join(", ")}`);
    return { ...(meta as unknown as DocMeta), path, body };
  });
}

/** Run step 1 for the configured edition and write data/1-docs.json. */
export async function run(edition = config.edition): Promise<Doc[]> {
  stepHeader(1, "load");
  const t0 = performance.now();
  line("IN", `corpus/${edition}/`);
  line("WHAT", "read every file · front matter → metadata (id, edition, department, access, lang) · body kept as-is");
  const docs = await loadCorpus(edition);
  line("OUT", `${docs.length} documents · ${docs.reduce((s, d) => s + d.body.length, 0)} characters`);
  for (const d of docs) {
    more(`${d.id.padEnd(24)} ${d.lang}  ${d.access.padEnd(8)} ${String(d.body.length).padStart(6)} chars  ${String(d.body.split("\n").length).padStart(4)} lines`);
  }
  const file = await writeStep("1-docs", docs, await corpusHash(edition));
  done(t0, file);
  return docs;
}
