// Solution — step 3, HOMEWORK: paragraph chunks with a title prefix.
import type { Chunk, CleanDoc } from "../src/lib/types.js";

export function byParagraph(doc: CleanDoc, max = 600): Chunk[] {
  const pieces: string[] = [];
  let buf = "";
  for (const p of doc.text.replace(/^# .*\n?/, "").split(/\n\n+/)) {
    if (buf && buf.length + p.length + 2 > max) {
      pieces.push(buf);
      buf = p;
    } else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf.trim()) pieces.push(buf);
  let section = "0";
  return pieces.map((piece, i) => {
    const heading = piece.match(/^## (\d+)\./m);
    if (heading) section = heading[1]!;
    return {
      id: `${doc.id}@${doc.edition}#p${String(i).padStart(2, "0")}`,
      docId: doc.id,
      edition: doc.edition,
      title: doc.title,
      access: doc.access,
      lang: doc.lang,
      sections: [section],
      text: `[${doc.title}]\n${piece}`,
    };
  });
}
