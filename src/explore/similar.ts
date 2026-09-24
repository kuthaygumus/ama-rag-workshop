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
  { kind: "paraphrase", a: "Tatil hakkım kaç gün?", b: "Yıllık ücretli izin süresi kıdeme göre belirlenir." },
  { kind: "TR ↔ EN", a: "Şifremi ne sıklıkla değiştirmem gerekiyor?", b: "Passwords must be changed every 90 days." },
  { kind: "twin tables", a: "Yurt içi seyahatte günlük harcırah ne kadar?", b: "Yurt dışı seyahatte günlük harcırah ne kadar?" },
  { kind: "negation trap", a: "Deneme süresindeki çalışanlar uzaktan çalışabilir.", b: "Deneme süresindeki çalışanlar uzaktan çalışamaz." },
  { kind: "unrelated", a: "Yemek kartına her ay yükleme yapılır.", b: "USB bellek kullanımı yasaktır." },
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
