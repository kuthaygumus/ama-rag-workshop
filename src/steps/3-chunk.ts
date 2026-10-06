// STEP 3 — CHUNK
// Gate: a whole document is too big to hand to the model on every question, and the answer to
// "how many days of leave?" lives in three lines of it. So we cut documents into pieces (chunks); later
// the search picks the few pieces that matter.
//
// HOW we cut decides what the search can ever find. Three ways below: fixed, section, and paragraph,
// which you write. Try them and run `npm run question`.
import { readStep, writeStep } from "../lib/data.js";
import { done, line, more, stepHeader } from "../lib/log.js";
import type { Chunk, CleanDoc } from "../lib/types.js";

export type ChunkerName = "section" | "fixed" | "paragraph";

// TOGGLE chunker — keep exactly one line active, then: npm run step -- 3  (and npm run question)
const CHUNKER: ChunkerName = "section"; // default
// const CHUNKER: ChunkerName = "fixed"; // alternative
// const CHUNKER: ChunkerName = "paragraph"; // alternative

/** A chunk that section-aware splitting would find too long is split again at paragraphs. */
const MAX_SECTION_CHARS = 1500;

/**
 * What it does: finds where each numbered "## n." section begins in a text.
 *
 * Where each "## n." section starts in the text.
 */
function sectionStarts(text: string): { n: string; at: number }[] {
  return [...text.matchAll(/^## (\d+)\./gm)].map((m) => ({ n: m[1]!, at: m.index! }));
}

/**
 * What it does: lists which section numbers a character range touches, so a chunk knows its sections.
 *
 * Section numbers overlapped by the character range [from, to). "0" = the part before section 1.
 */
export function sectionsIn(text: string, from: number, to: number): string[] {
  const starts = sectionStarts(text);
  const out: string[] = [];
  starts.forEach((s, i) => {
    const end = starts[i + 1]?.at ?? text.length;
    if (s.at < to && end > from) out.push(s.n);
  });
  if (!out.length || (starts[0] && from < starts[0].at)) out.unshift("0");
  return [...new Set(out)];
}

/** What it does: builds the labels every chunk carries: document id, edition, title, access, language. */
export const base = (d: CleanDoc) => ({ docId: d.id, edition: d.edition, title: d.title, access: d.access, lang: d.lang });

/**
 * What it does: cuts a document into equal-size chunks, blind to headings and tables.
 *
 * Cut every `size` characters, blind to what is there — mid-word, mid-table, mid-sentence.
 * The baseline everyone starts with.
 * @example fixedSize(doc, 300).length // ≈ doc.text.length / 300
 */
export function fixedSize(doc: CleanDoc, size = 300): Chunk[] {
  const chunks: Chunk[] = [];
  for (let at = 0, n = 0; at < doc.text.length; at += size, n++) {
    const text = doc.text.slice(at, at + size);
    if (!text.trim()) continue;
    chunks.push({
      ...base(doc),
      id: `${doc.id}@${doc.edition}#c${String(n).padStart(2, "0")}`,
      sections: sectionsIn(doc.text, at, at + size),
      text,
    });
  }
  return chunks;
}

/**
 * What it does: joins paragraphs into pieces, starting a new piece before the size limit is passed.
 *
 * Pack paragraphs into pieces of at most `max` characters.
 */
export function packParagraphs(body: string, max: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const p of body.split(/\n\n+/)) {
    if (buf && buf.length + p.length + 2 > max) {
      out.push(buf);
      buf = p;
    } else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * What it does: cuts a document at its numbered headings, with title and heading in front.
 *
 * Cut at the document's own headings ("## 3. Annual Paid Leave") and put the document title and
 * heading in front of every chunk. A table then stays with the heading that explains it, and even a
 * chunk that is mostly numbers says what it is about.
 * @example bySection(doc)[0].text // "[Annual Leave Policy › 1. Purpose and Scope]\n…"
 */
export function bySection(doc: CleanDoc): Chunk[] {
  const parts = doc.text.split(/\n(?=## \d+\.)/);
  const chunks: Chunk[] = [];
  for (const part of parts) {
    const m = part.match(/^## ((\d+)\..*)\n([\s\S]*)$/);
    const [heading, n, body] = m ? [m[1]!.trim(), m[2]!, m[3]!.trim()] : ["", "0", part.replace(/^# .*\n?/, "").trim()];
    if (!body) continue;
    const prefix = heading ? `[${doc.title} › ${heading}]` : `[${doc.title}]`;
    const pieces = body.length > MAX_SECTION_CHARS ? packParagraphs(body, MAX_SECTION_CHARS) : [body];
    pieces.forEach((piece, i) =>
      chunks.push({
        ...base(doc),
        id: `${doc.id}@${doc.edition}#${n}${pieces.length > 1 ? `.${i + 1}` : ""}`,
        sections: [n],
        text: `${prefix}\n${piece}`,
      }),
    );
  }
  return chunks;
}

// ── YOUR TURN ───────────────────────────────────────────────────────────────────────────────────
// A third way to cut: by paragraph. It sits between fixed and section.
// 1. Remove the "# title" line. Cut the rest at blank lines.
//    Pack the paragraphs into pieces of up to `max` characters. packParagraphs() does this.
// 2. Put the title in front of each piece, like bySection does: "[title]\n" + piece.
// 3. Give each chunk the sections it touches. fixedSize() above shows how:
//    it calls sectionsIn() on the text it cuts, with the start and the end of the piece.
// 4. Give each chunk an id like "hr-leave@2025#p03". base() fills the other labels.
// Check: npm run check:sibling -- -t byParagraph
// Then switch the TOGGLE chunker to "paragraph". Run npm run step -- 3, then npm run question.
// Then switch the TOGGLE back to "section" and run npm run step -- 3 again.
// We measure it on the Measuring quality page.

/**
 * What it does: cuts a document at blank lines, packs paragraphs up to a size limit, puts the title in front.
 *
 * Paragraph chunks with a title prefix, each at most `max` characters (plus the prefix).
 * Each chunk lists every section it touches.
 * @example byParagraph(doc, 600).every((c) => c.text.startsWith(`[${doc.title}]`)) // true
 */
export function byParagraph(doc: CleanDoc, max = 600): Chunk[] {
  throw new Error("byParagraph() is not written yet — see the YOUR TURN note above it in src/steps/3-chunk.ts");
}

export const CHUNKERS: Record<ChunkerName, (d: CleanDoc) => Chunk[]> = {
  section: bySection,
  fixed: (d) => fixedSize(d, 300),
  paragraph: (d) => byParagraph(d, 600),
};

/** The words to look for: which chunk holds the row the day's question needs? */
const WATCH = "| 7 |";

/**
 * What it does: cuts the documents into chunks, prints the chunk with row 7, and saves data/3-chunks.json.
 *
 * Run step 3 on data/2-clean.json and write data/3-chunks.json.
 * @param chunker defaults to the TOGGLE above
 */
export async function run(chunker: ChunkerName = CHUNKER): Promise<Chunk[]> {
  stepHeader(3, "chunk");
  const t0 = performance.now();
  const input = await readStep<CleanDoc[]>("2-clean", "1-docs");
  line("IN", `data/2-clean.json  (${input.data.length} documents)`);
  line(
    "WHAT",
    chunker === "fixed"
      ? "fixed: a cut every 300 characters, blind to headings and tables"
      : chunker === "paragraph"
        ? "paragraph: a cut at blank lines, packed up to 600 characters, title kept in front"
        : "section: a cut at every '## n.' heading, title › heading kept in front",
  );
  const chunks = input.data.flatMap(CHUNKERS[chunker]);
  const sizes = chunks.map((c) => c.text.length);
  line(
    "OUT",
    `${chunks.length} chunks · avg ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} chars · min ${Math.min(...sizes)} · max ${Math.max(...sizes)}`,
  );
  const watched = chunks.filter((c) => c.text.includes(WATCH) && c.docId === "hr-leave");
  for (const c of watched) {
    more("");
    more(`the chunk holding "${WATCH}" → ${c.id}  (sections ${c.sections.join(",")})`);
    c.text.split("\n").forEach((l) => more(`  │ ${l}`));
  }
  const file = await writeStep("3-chunks", chunks, input.hash);
  done(t0, file);
  return chunks;
}
