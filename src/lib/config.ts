// Every setting in one place. Three ways to change one, strongest first:
//   1. a flag:      npm run step -- 5 --store json
//   2. a .env file: STORE=json   (copy env.example; works the same in PowerShell, cmd and zsh)
//   3. the default written here
// Never `STORE=json npm run …` — that syntax does not exist on Windows.
import { parseArgs } from "node:util";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env — defaults and flags are enough
}

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  allowPositionals: true,
  options: {
    store: { type: "string" },
    edition: { type: "string" },
    k: { type: "string" },
    prompt: { type: "boolean" },
    bare: { type: "boolean" },
    reset: { type: "boolean" },
    answers: { type: "boolean" },
    metric: { type: "string" },
  },
});

/** CLI flags and positional arguments, parsed once for every entry point. */
export const cli = { flags, positionals };

function flag(name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export type StoreKind = "chroma" | "json";

export const config = {
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  chromaUrl: process.env.CHROMA_URL ?? "http://localhost:8000",

  /** Writes the answer. It only ever sees what we put in the prompt. */
  chatModel: process.env.CHAT_MODEL ?? "gemma3:4b",
  /** Text → 1024 numbers. Must be the SAME model at ingest time and at question time. */
  embedModel: process.env.EMBED_MODEL ?? "bge-m3",

  /** Which corpus/<edition>/ folder step 1 reads. */
  edition: flag("edition") ?? process.env.EDITION ?? "2025",
  /** Where step 5 puts the vectors: Chroma in Podman, or a plain JSON file (no Podman needed). */
  store: (flag("store") ?? process.env.STORE ?? "chroma") as StoreKind,
  collection: "kraken-policies",

  /** How many chunks the retriever hands on (to the reranker, or straight to the prompt). */
  topK: Number(flag("k") ?? 5),
  /** How many chunks finally go into the prompt. */
  contextK: 3,

  /** Ollama's default context window is small; our prompts need room for 3 chunks + rules. */
  numCtx: 8192,
  /** temperature 0 + a fixed seed = the same answer on every laptop in the room. */
  seed: 42,
  /** Chunks per /api/embed call. */
  embedBatch: 24,

  dataDir: "data",
  cacheFile: ".cache/embeddings.json",

  /** The day's question. Its answer moves as the pipeline grows. */
  dayQuestion: "7 yıllık bir çalışanın yıllık izni kaç iş günü?",
};
