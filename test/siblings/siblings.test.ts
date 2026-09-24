// The "write the sibling" exercises. Red until you write them — that is the point.
//   npm run check:sibling               tests YOUR functions in src/
//   SOLUTIONS=1 npm run check:sibling   tests the finished ones in solutions/ (trainer check)
import { describe, expect, it } from "vitest";
import type { CleanDoc } from "../../src/lib/types.js";

const solutions = Boolean(process.env.SOLUTIONS);
const footer = solutions ? await import("../../solutions/english-footer.js") : await import("../../src/steps/2-clean.js");
const similarity = solutions ? await import("../../solutions/dot.js") : await import("../../src/lib/similarity.js");
const chunking = solutions ? await import("../../solutions/by-paragraph.js") : await import("../../src/steps/3-chunk.js");

describe("step 2 · englishFooter", () => {
  it("matches the English footer and nothing else", () => {
    expect(footer.englishFooter, "englishFooter is still undefined — write the rule").toBeInstanceOf(RegExp);
    expect(footer.englishFooter!.test("CONFIDENTIAL – Internal use only")).toBe(true);
    expect(footer.englishFooter!.test("Confidential data must be encrypted.")).toBe(false);
    expect(footer.englishFooter!.test("GİZLİ – Yalnızca şirket içi kullanım içindir")).toBe(false);
  });
});

describe("similarity · dot", () => {
  it("sums the element-wise products", () => {
    expect(similarity.dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(similarity.dot([1, 0], [0, 1])).toBe(0);
  });
  it("equals cosine for vectors of length 1", () => {
    const a = [0.6, 0.8], b = [1, 0];
    expect(similarity.dot(a, b)).toBeCloseTo(0.6);
  });
});

describe("step 3 · byParagraph (homework)", () => {
  const doc: CleanDoc = {
    id: "d", title: "Doc", edition: "2025", department: "x", access: "all", lang: "tr", noiseLines: 0,
    text: "# Doc\n\n## 1. One\n\n" + "a ".repeat(200) + "\n\n" + "b ".repeat(200) + "\n\n## 2. Two\n\nshort",
  };
  it("packs paragraphs under the limit and keeps the title prefix", () => {
    const chunks = chunking.byParagraph(doc, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.startsWith("[Doc]")).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(500 + "[Doc]\n".length);
    }
  });
});
