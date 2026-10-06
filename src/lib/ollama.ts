// Two calls to Ollama and nothing else: text → vectors, prompt → answer.
// Plain fetch on purpose — the request bodies ARE the lesson. Bruno's 00-ollama folder sends the
// same bodies by hand.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";

export class OllamaError extends Error {}

/** What it does: sends a JSON POST to Ollama and returns the reply, with clear errors. */
async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.ollamaUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new OllamaError(`Ollama is not reachable at ${config.ollamaUrl}. Is it running? (${(e as Error).message})`);
  }
  if (!res.ok) {
    const detail = await res.text();
    const hint = res.status === 404 ? ` — is the model pulled? Try: ollama pull ${(body as { model: string }).model}` : "";
    throw new OllamaError(`Ollama ${path} → HTTP ${res.status}: ${detail}${hint}`);
  }
  return (await res.json()) as T;
}

/**
 * What it does: asks Ollama which models are installed on this machine.
 *
 * Names of the models installed in the local Ollama, e.g. `["bge-m3:latest", "gemma3:4b"]`.
 */
export async function installedModels(): Promise<string[]> {
  const res = await fetch(`${config.ollamaUrl}/api/tags`);
  if (!res.ok) throw new OllamaError(`Ollama /api/tags → HTTP ${res.status}`);
  const data = (await res.json()) as { models: { name: string }[] };
  return data.models.map((m) => m.name);
}

// ── embeddings ──────────────────────────────────────────────────────────────────────────────────
// The same text with the same model always gives the same vector, so we keep every vector we have
// computed in .cache/. Re-running a step (or catch-up) then costs milliseconds, not minutes.

type Cache = Record<string, number[]>;
let cache: Cache | undefined;

/** What it does: builds a fingerprint from the model and the text, used as the cache key. */
const cacheKey = (model: string, text: string) => createHash("sha256").update(`${model}\n${text}`).digest("hex");

/** What it does: reads the embedding cache file once, or starts with an empty cache. */
async function loadCache(): Promise<Cache> {
  if (!cache) {
    try {
      cache = JSON.parse(await readFile(config.cacheFile, "utf8")) as Cache;
    } catch {
      cache = {};
    }
  }
  return cache;
}

/** What it does: writes the embedding cache back to the cache file. */
async function saveCache(): Promise<void> {
  await mkdir(dirname(config.cacheFile), { recursive: true });
  await writeFile(config.cacheFile, JSON.stringify(cache));
}

export interface EmbedResult {
  vectors: number[][];
  /** How many texts actually went to Ollama (the rest came from the cache). */
  computed: number;
}

/**
 * What it does: turns texts into vectors with the embedding model, and reuses cached vectors.
 *
 * Turn texts into vectors with the embedding model — one vector per text, same order.
 * Sends them in batches of `config.embedBatch`; texts seen before come from the cache.
 * @param texts the chunks (at ingest) or the question (at query time)
 * @returns the vectors and how many were freshly computed
 * @example const { vectors } = await embed(["annual leave"]); vectors[0].length // 1024
 */
export async function embed(texts: string[], model = config.embedModel): Promise<EmbedResult> {
  const store = await loadCache();
  const missing = [...new Set(texts.filter((t) => !store[cacheKey(model, t)]))];
  for (let i = 0; i < missing.length; i += config.embedBatch) {
    const batch = missing.slice(i, i + config.embedBatch);
    const data = await post<{ embeddings: number[][] }>("/api/embed", { model, input: batch });
    batch.forEach((t, j) => (store[cacheKey(model, t)] = data.embeddings[j]!));
  }
  if (missing.length) await saveCache();
  return { vectors: texts.map((t) => store[cacheKey(model, t)]!), computed: missing.length };
}

// ── generation ──────────────────────────────────────────────────────────────────────────────────

export interface Generation {
  text: string;
  /** Tokens the model had to read: system + prompt. This is what you pay for. */
  promptTokens: number;
  outputTokens: number;
  ms: number;
}

export interface GenerateOptions {
  system?: string;
  /** A JSON schema: Ollama then forces the output into that shape (used by the reranker). */
  format?: object;
  model?: string;
  /** Context window in tokens; defaults to config.numCtx. */
  numCtx?: number;
}

/**
 * What it does: sends the prompt to the chat model and returns its answer.
 *
 * Ask the chat model. Deterministic on purpose: temperature 0 and a fixed seed, so the same machine
 * gives the same answer to the same prompt (other hardware may differ slightly).
 * @param prompt the user message — for RAG, the sources plus the question
 * @returns the answer text with its token counts and duration
 */
export async function generate(prompt: string, o: GenerateOptions = {}): Promise<Generation> {
  const t0 = performance.now();
  const data = await post<{ response: string; prompt_eval_count?: number; eval_count?: number }>("/api/generate", {
    model: o.model ?? config.chatModel,
    system: o.system ?? "",
    prompt,
    stream: false,
    ...(o.format ? { format: o.format } : {}),
    options: { temperature: 0, seed: config.seed, num_ctx: o.numCtx ?? config.numCtx },
  });
  return {
    text: data.response.trim(),
    promptTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
    ms: Math.round(performance.now() - t0),
  };
}
