// STEP 4b — "embedding done — what do we have?" (part 1)
// npm run similar                      the prepared pairs below
// npm run similar -- "text a" "text b" your own pair
// npm run similar -- --metric l2       the same pairs, measured as a distance (smaller = closer)
//
// The embedding model decided which texts are close. Before we trust it with retrieval, look at a few
// of its decisions — including one where it is confidently wrong.
import { cli } from "../lib/config.js";
import { banner, dim, line, more } from "../lib/log.js";
import { embed } from "../lib/ollama.js";
import { cosine, dot, l2 } from "../lib/similarity.js";
import { exitOnError } from "../cli/errors.js";

const PAIRS: { kind: string; a: string; b: string }[] = [
  { kind: "paraphrase", a: "How much holiday do I get?", b: "Annual paid leave depends on the length of service." },
  { kind: "EN ↔ TR", a: "How often must I change my password?", b: "Şifreler 90 günde bir değiştirilmelidir." },
  { kind: "twin tables", a: "How much is the domestic per diem?", b: "How much is the international per diem?" },
  { kind: "negation trap", a: "Employees on probation can work remotely.", b: "Employees on probation cannot work remotely." },
  { kind: "unrelated", a: "Your meal card is loaded every month.", b: "USB sticks are not allowed." },
];

const METRICS = { cosine, dot, l2 } as const;
type Metric = keyof typeof METRICS;

/** A 20-character bar for a similarity between 0 and 1. */
const bar = (x: number) => "█".repeat(Math.round(Math.max(0, Math.min(1, x)) * 20)).padEnd(20, "░");

async function main(): Promise<void> {
  const metric = (typeof cli.flags.metric === "string" ? cli.flags.metric : "cosine") as Metric;
  if (!METRICS[metric]) throw new Error(`--metric must be one of: ${Object.keys(METRICS).join(", ")}`);
  const [a, b] = cli.positionals;
  const pairs = a && b ? [{ kind: "your pair", a, b }] : PAIRS;

  banner(`STEP 4b · SIMILAR — which texts did the model put close together?`);
  line("WHAT", `embed both texts, measure ${metric}${metric === "l2" ? " (a distance: SMALLER = closer)" : " (1 = same direction)"}`);
  const { vectors } = await embed(pairs.flatMap((p) => [p.a, p.b]));
  pairs.forEach((p, i) => {
    const x = METRICS[metric](vectors[2 * i]!, vectors[2 * i + 1]!);
    more("");
    more(`${x.toFixed(3)} ${metric === "l2" ? "" : bar(x)}  ${p.kind}`);
    more(dim(`   ${p.a}`));
    more(dim(`   ${p.b}`));
  });
  console.log();
}

await main().catch(exitOnError);
