// STEP 0 — BARE MODEL
// Gate: before building anything, ask the model on its own. It has never seen our policy handbook —
// watch what it does instead of saying so.
import { config } from "../lib/config.js";
import { done, line, stepHeader, yellow } from "../lib/log.js";
import { generate } from "../lib/ollama.js";

/**
 * Ask the chat model a question with no sources at all.
 * @param question defaults to the day's question
 * @returns the model's answer text
 */
export async function run(question = config.dayQuestion): Promise<string> {
  stepHeader(0, "bare model");
  const t0 = performance.now();
  line("IN", question);
  line("WHAT", `ask ${config.chatModel} directly — no documents, no search`);
  const gen = await generate(question, { system: "Kısa cevap ver." });
  line("OUT", `${gen.promptTokens} prompt tokens · ${gen.outputTokens} output tokens`);
  console.log(`\n${yellow(gen.text)}\n`);
  done(t0);
  return gen.text;
}
