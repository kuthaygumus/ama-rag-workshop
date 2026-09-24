// Known problems print one readable line with the fix. Anything else prints the full stack.
import { StaleInputError } from "../lib/data.js";
import { OllamaError } from "../lib/ollama.js";
import { red } from "../lib/log.js";

/** Print an error the way a participant can act on it, then exit with code 1. */
export function exitOnError(e: unknown): never {
  const known = e instanceof StaleInputError || e instanceof OllamaError || /not reachable|No folder|front matter/.test(String(e));
  console.error(`\n${red("✗")} ${known ? (e as Error).message : (e as Error).stack ?? String(e)}\n`);
  process.exit(1);
}
