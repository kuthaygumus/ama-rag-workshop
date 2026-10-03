// npm run doctor
// Is this laptop ready for the day? Checks every moving part once and times one real answer.
import { readdir, readFile } from "node:fs/promises";
import { config } from "../lib/config.js";
import { heartbeat } from "../lib/chroma.js";
import { banner, green, more, red, yellow } from "../lib/log.js";
import { embed, generate, installedModels } from "../lib/ollama.js";

let failed = 0;
const ok = (what: string, detail = "") => more(`${green("✓")} ${what.padEnd(28)} ${detail}`);
const fail = (what: string, fix: string) => {
  failed++;
  more(`${red("✗")} ${what.padEnd(28)} ${yellow(fix)}`);
};

banner("DOCTOR");

const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) ok("Node.js", process.versions.node);
else fail("Node.js", `found ${process.versions.node}, need 22 or newer — https://nodejs.org`);

let models: string[] = [];
try {
  models = await installedModels();
  ok("Ollama", config.ollamaUrl);
} catch {
  fail("Ollama", `not reachable at ${config.ollamaUrl} — start the Ollama app`);
}
for (const m of [config.chatModel, config.embedModel]) {
  if (!models.length) break;
  if (models.includes(m) || models.includes(`${m}:latest`)) ok(`model ${m}`);
  else fail(`model ${m}`, `not pulled — run: ollama pull ${m}`);
}

if (config.store === "chroma") {
  if (await heartbeat()) ok("Chroma", config.chromaUrl);
  else fail("Chroma", "not reachable — run: podman compose up -d   (or set STORE=json in .env)");
} else ok("store", "json (no Podman needed)");

try {
  const files = (await readdir(`corpus/${config.edition}`)).filter((f) => f.endsWith(".md"));
  // Languages from each file's front matter, most common first: an old clone shows other numbers here.
  const langs = new Map<string, number>();
  for (const f of files) {
    const lang = (await readFile(`corpus/${config.edition}/${f}`, "utf8")).match(/^lang:\s*(\S+)/m)?.[1] ?? "?";
    langs.set(lang, (langs.get(lang) ?? 0) + 1);
  }
  const mix = [...langs].sort((x, y) => y[1] - x[1]).map(([l, n]) => `${n} ${l}`).join(", ");
  ok(`corpus/${config.edition}`, `${files.length} documents · ${mix}`);
} catch {
  fail(`corpus/${config.edition}`, "missing — run npm run doctor from the repo folder");
}

if (!failed) {
  const t0 = performance.now();
  const { vectors } = await embed([`doctor check ${Date.now()}`]);
  ok("embed one sentence", `${vectors[0]!.length} numbers · ${Math.round(performance.now() - t0)} ms`);
  const gen = await generate("Answer in one word: what is the capital of Turkey?");
  ok("one answer", `${gen.ms} ms · "${gen.text.slice(0, 30)}"`);
  if (gen.ms > 20000) more(yellow("  slow laptop: answers will take a while — that is fine, the steps still work"));
}

console.log(failed ? `\n${red(`${failed} problem(s) — fix them before the day starts.`)}\n` : `\n${green("Ready.")}\n`);
process.exit(failed ? 1 : 0);
