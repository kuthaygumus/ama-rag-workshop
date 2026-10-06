// Solution — step 3, YOUR TURN: paragraph chunks with a title prefix and the sections they touch.
import type { Chunk, CleanDoc } from "../src/lib/types.js";
import { base, packParagraphs, sectionsIn } from "../src/steps/3-chunk.js";

/**
 * What it does: cuts a document at blank lines, packs paragraphs up to a size limit, puts the title in front.
 *
 * Like fixedSize(), it tracks where each piece starts, so a chunk lists every section it touches.
 * @example byParagraph(doc, 600)[0].id // "hr-leave@2025#p00"
 */
export function byParagraph(doc: CleanDoc, max = 600): Chunk[] {
  const body = doc.text.replace(/^# .*\n?/, "").trim();
  let at = 0;
  return packParagraphs(body, max).map((piece, i) => {
    at = body.indexOf(piece, at); // where this piece starts in the body
    return {
      ...base(doc),
      id: `${doc.id}@${doc.edition}#p${String(i).padStart(2, "0")}`,
      sections: sectionsIn(body, at, at + piece.length),
      text: `[${doc.title}]\n${piece}`,
    };
  });
}
