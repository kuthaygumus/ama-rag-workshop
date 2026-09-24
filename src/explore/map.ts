// STEP 4b — "embedding done — what do we have?" (part 2)
// npm run map [-- "a question"]
// Every chunk from data/4-vectors.json as a dot on a 2-D map, one colour per document, and the question
// as a star. Open data/map.html in a browser. Chunks of the same document should cluster; the star
// should land next to the chunks that answer it.
import { mkdir, writeFile } from "node:fs/promises";
import { cli, config } from "../lib/config.js";
import { readStep } from "../lib/data.js";
import { banner, done, line, more } from "../lib/log.js";
import { embed } from "../lib/ollama.js";
import type { Vectors } from "../steps/4-embed.js";
import { exitOnError } from "../cli/errors.js";
import { pca2, project } from "./pca.js";

const COLORS = ["#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d", "#1f78b4", "#666666"];

export interface MapPoint {
  id: string;
  docId: string;
  x: number;
  y: number;
  text: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A self-contained HTML page: inline SVG, no scripts, no network. */
function html(points: MapPoint[], star: { x: number; y: number; text: string }, explained: [number, number]): string {
  const W = 900, H = 620, P = 40;
  const xs = [...points.map((p) => p.x), star.x], ys = [...points.map((p) => p.y), star.y];
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * P - 200);
  const sy = (y: number) => H - P - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * P);
  const docs = [...new Set(points.map((p) => p.docId))];
  const color = (d: string) => COLORS[docs.indexOf(d) % COLORS.length];
  const dots = points
    .map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="6" fill="${color(p.docId)}" fill-opacity=".8"><title>${esc(p.id)}\n${esc(p.text.slice(0, 200))}</title></circle>`)
    .join("\n");
  const [qx, qy] = [sx(star.x), sy(star.y)];
  const starPath = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 6 : 15, a = (Math.PI / 5) * i - Math.PI / 2;
    return `${(qx + r * Math.cos(a)).toFixed(1)},${(qy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  const legend = docs.map((d, i) => `<g transform="translate(${W - 190},${P + i * 22})"><circle r="6" cx="6" cy="0" fill="${color(d)}"/><text x="18" y="4">${esc(d)}</text></g>`).join("\n");
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Vector map</title>
<style>:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mute:#777}@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mute:#999}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}svg{max-width:100%;height:auto}text{fill:var(--fg);font-size:12px}.m{fill:var(--mute)}</style></head>
<body><h1 style="font-size:18px;margin:0 0 4px">Our policies in 2-D</h1>
<p style="margin:0 0 12px;color:var(--mute)">Hover a dot to read its chunk. ★ = ${esc(star.text)}</p>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chunks projected to two dimensions">
<text class="m" x="${P}" y="${H - 8}">PC1 keeps ${(explained[0] * 100).toFixed(1)}% of the spread · PC2 ${(explained[1] * 100).toFixed(1)}% · the other 1022 dimensions hold the rest</text>
${dots}
<polygon points="${starPath}" fill="#ffd400" stroke="var(--fg)" stroke-width="1.5"><title>${esc(star.text)}</title></polygon>
${legend}
</svg></body></html>`;
}

async function main(): Promise<void> {
  const question = cli.positionals[0] ?? config.dayQuestion;
  banner("STEP 4b · MAP — our chunks in two dimensions");
  const t0 = performance.now();
  const input = await readStep<Vectors>("4-vectors", "3-chunks");
  line("IN", `data/4-vectors.json  (${input.data.chunks.length} vectors × ${input.data.dimensions})`);
  line("WHAT", "PCA: the 2 directions along which the chunks differ most · the question projected onto them");
  const p = pca2(input.data.chunks.map((c) => c.vector));
  const { vectors: [q] } = await embed([question]);
  const [x, y] = project(p, q!);
  const points: MapPoint[] = input.data.chunks.map((c, i) => ({ id: c.id, docId: c.docId, x: p.coords[i]![0], y: p.coords[i]![1], text: c.text }));
  line("OUT", `PC1 keeps ${(p.explained[0] * 100).toFixed(1)}% · PC2 ${(p.explained[1] * 100).toFixed(1)}% of the spread`);
  const nearest = [...points].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)).slice(0, 3);
  more(`★ "${question}" lands next to: ${nearest.map((n) => n.id).join(", ")}  (on the 2-D map — step 6 measures in all 1024)`);
  await mkdir(config.dataDir, { recursive: true });
  await writeFile("data/map.json", JSON.stringify({ explained: p.explained, question: { text: question, x, y }, points }, null, 1));
  await writeFile("data/map.html", html(points, { x, y, text: question }, p.explained));
  done(t0, "data/map.html (open it in a browser) + data/map.json");
}

await main().catch(exitOnError);
