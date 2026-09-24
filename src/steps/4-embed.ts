// STEP 4 — EMBED
// Gate: words are not meaning. "tatil hakkım" and "yıllık ücretli izin" share no word, yet mean the
// same thing; a keyword search cannot see that. An embedding model turns a text into a list of numbers
// (a vector) so that texts with similar meaning land close together.
//
// The model is a neural network trained on millions of "these two texts mean the same" pairs. WE do
// not decide what is close — the model does. Step 4b lets you look at what it decided.
import { config } from "../lib/config.js";
import { readStep, writeStep } from "../lib/data.js";
import { done, line, more, stepHeader } from "../lib/log.js";
import { embed } from "../lib/ollama.js";
import { norm } from "../lib/similarity.js";
import type { Chunk, VectorChunk } from "../lib/types.js";

export interface Vectors {
  /** Recorded so that a question embedded with a different model is refused (step 6). */
  embedModel: string;
  dimensions: number;
  chunks: VectorChunk[];
}

/** Run step 4 on data/3-chunks.json and write data/4-vectors.json. */
export async function run(): Promise<Vectors> {
  stepHeader(4, "embed");
  const t0 = performance.now();
  const input = await readStep<Chunk[]>("3-chunks", "2-clean");
  line("IN", `data/3-chunks.json  (${input.data.length} chunks)`);
  line("WHAT", `send each chunk's text to ${config.embedModel} (Ollama /api/embed, ${config.embedBatch} per call)`);

  const { vectors, computed } = await embed(input.data.map((c) => c.text));
  const ms = Math.round(performance.now() - t0);
  const first = vectors[0] ?? [];
  line("OUT", `${vectors.length} vectors · ${first.length} numbers each · ${computed} computed, ${vectors.length - computed} from cache`);
  more(`${input.data[0]?.id} → [${first.slice(0, 6).map((x) => x.toFixed(4)).join(", ")}, … ]`);
  more(`length (norm) of that vector: ${norm(first).toFixed(3)}`);
  if (computed) more(`${(ms / computed).toFixed(1)} ms per chunk`);

  const out: Vectors = {
    embedModel: config.embedModel,
    dimensions: first.length,
    chunks: input.data.map((c, i) => ({ ...c, vector: vectors[i]! })),
  };
  const file = await writeStep("4-vectors", out, input.hash);
  done(t0, file);
  return out;
}
