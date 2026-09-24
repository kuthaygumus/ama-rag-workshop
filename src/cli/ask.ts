// npm run ask -- "question" [--prompt] [--bare] [--k 8]
// The online half, steps 6–8 for any question: retrieve → rerank → answer.
//   --prompt   print the exact text the model receives
//   --bare     first ask the model with NO sources (step 0), for comparison
//   --k N      how many chunks the retriever hands on
import { cli } from "../lib/config.js";
import { run as bare } from "../steps/0-bare.js";
import { run as retrieve } from "../steps/6-retrieve.js";
import { run as rerank } from "../steps/7-rerank.js";
import { run as answer } from "../steps/8-answer.js";
import { exitOnError } from "./errors.js";

const question = cli.positionals[0];
if (!question) {
  console.error('usage: npm run ask -- "Yurt dışı harcırahı ne kadar?" [--prompt] [--bare] [--k 8]');
  process.exit(1);
}
try {
  if (cli.flags.bare) await bare(question);
  await retrieve(question);
  await rerank();
  await answer();
} catch (e) {
  exitOnError(e);
}
