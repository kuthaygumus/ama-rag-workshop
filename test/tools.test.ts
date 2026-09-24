import { describe, expect, it } from "vitest";
import { resetToggles } from "../src/lib/toggles.js";
import { score, sectionRanking } from "../src/lib/metrics.js";
import { pca2, project } from "../src/explore/pca.js";
import { cosine, l2, norm } from "../src/lib/similarity.js";
import type { Hit } from "../src/lib/types.js";

describe("similarity", () => {
  it("cosine ignores length, l2 does not", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(l2([0, 0], [3, 4])).toBe(5);
    expect(norm([3, 4])).toBe(5);
  });
});

describe("eval metrics", () => {
  const hit = (docId: string, sections: string[]): Hit => ({ score: 0, chunk: { id: "", docId, edition: "2025", title: "", access: "all", lang: "tr", sections, text: "" } });

  it("collapses chunks to sections, best first, each once", () => {
    expect(sectionRanking([hit("a", ["2", "3"]), hit("b", ["1"]), hit("a", ["3"])])).toEqual(["a#2", "a#3", "b#1"]);
  });
  it("scores hit@1, recall@k and reciprocal rank", () => {
    expect(score(["a#2", "a#3", "b#1"], ["a#3"], 5)).toEqual({ hit1: 0, recall: 1, rr: 0.5 });
    expect(score(["a#3"], ["a#3"], 5)).toEqual({ hit1: 1, recall: 1, rr: 1 });
    expect(score(["b#1"], ["a#3"], 5)).toEqual({ hit1: 0, recall: 0, rr: 0 });
  });
});

describe("catch-up toggles", () => {
  const src = [
    "// TOGGLE chunker",
    '// const C = "section"; // default',
    'const C = "fixed"; // alternative',
    "",
    'const untouched = "fixed"; // alternative',
  ].join("\n");

  it("activates defaults, comments alternatives, only inside TOGGLE blocks", () => {
    const { source, changed } = resetToggles(src);
    expect(changed).toBe(2);
    expect(source.split("\n").slice(1, 3)).toEqual(['const C = "section"; // default', '// const C = "fixed"; // alternative']);
    expect(source.split("\n")[4]).toBe('const untouched = "fixed"; // alternative');
  });
  it("is idempotent", () => {
    const once = resetToggles(src).source;
    expect(resetToggles(once)).toEqual({ source: once, changed: 0 });
  });
});

describe("PCA", () => {
  const x = [
    [2, 0, 0], [-2, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 0.1],
  ];
  it("finds the widest direction first and keeps most of the spread", () => {
    const p = pca2(x);
    expect(Math.abs(p.axes[0][0]!)).toBeCloseTo(1, 3);
    expect(Math.abs(p.axes[1][1]!)).toBeCloseTo(1, 3);
    expect(p.explained[0] + p.explained[1]).toBeGreaterThan(0.99);
  });
  it("is deterministic and projects a training vector onto its own coordinates", () => {
    const a = pca2(x), b = pca2(x);
    expect(a.coords).toEqual(b.coords);
    const [px, py] = project(a, x[0]!);
    expect(px).toBeCloseTo(a.coords[0]![0]);
    expect(py).toBeCloseTo(a.coords[0]![1]);
  });
});
