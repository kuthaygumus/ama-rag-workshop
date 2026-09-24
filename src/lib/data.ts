// Every step writes its result to data/<n>-<name>.json, so you can open it and look.
// Each file records a fingerprint (hash) of its own content and of the file it was made from.
// The next step compares them and refuses to run on stale input: change the chunker, re-run
// step 3, forget step 4 — and step 5 tells you, instead of silently storing old vectors.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export interface StepFile<T> {
  file: string;
  createdAt: string;
  /** Fingerprint of `data`. */
  hash: string;
  /** Fingerprint of the input this file was made from. */
  inputHash: string;
  data: T;
}

export class StaleInputError extends Error {}

/** A short, stable fingerprint of any JSON-able value. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/** data/3-chunks.json for "3-chunks". */
export const dataPath = (name: string) => join(config.dataDir, `${name}.json`);

/**
 * Write a step's result.
 * @param name file name without extension, e.g. "3-chunks"
 * @param data the payload participants will open
 * @param inputHash `hash` of the input file (or of the corpus, for step 1)
 * @returns the path written, for the TIME line of the log
 */
export async function writeStep<T>(name: string, data: T, inputHash: string): Promise<string> {
  const file = dataPath(name);
  const out: StepFile<T> = { file, createdAt: new Date().toISOString(), hash: hashOf(data), inputHash, data };
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(out, null, 2));
  return file;
}

/**
 * Read a step's result. With `upstream`, also check that it was made from the CURRENT upstream file.
 * @param name e.g. "3-chunks"
 * @param upstream e.g. "2-clean" — the file `name` was made from
 * @throws StaleInputError with the command that fixes it
 */
export async function readStep<T>(name: string, upstream?: string): Promise<StepFile<T>> {
  const step = name.split("-")[0];
  let file: StepFile<T>;
  try {
    file = JSON.parse(await readFile(dataPath(name), "utf8")) as StepFile<T>;
  } catch {
    throw new StaleInputError(`${dataPath(name)} does not exist yet. Run: npm run step -- ${step}`);
  }
  if (upstream) {
    const up = await readStep<unknown>(upstream);
    if (up.hash !== file.inputHash) {
      throw new StaleInputError(
        `${dataPath(name)} was made from an older ${dataPath(upstream)}. Run it again: npm run step -- ${step}`,
      );
    }
  }
  return file;
}

/** Delete everything in data/ (catch-up does this). The embedding cache lives in .cache/ and survives. */
export async function clearData(): Promise<void> {
  await rm(config.dataDir, { recursive: true, force: true });
}
