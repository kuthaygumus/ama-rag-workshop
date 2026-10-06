// The "write the sibling" exercises. Red until you write them — that is the point.
//   npm run check:sibling               tests YOUR functions in src/
//   SOLUTIONS=1 npm run check:sibling   tests the finished ones in solutions/ (trainer check)
import { describe, expect, it } from "vitest";
import type { CleanDoc } from "../../src/lib/types.js";

const solutions = Boolean(process.env.SOLUTIONS);
const confidential = solutions ? await import("../../solutions/turkish-confidential.js") : await import("../../src/steps/2-clean.js");
const similarity = solutions ? await import("../../solutions/dot.js") : await import("../../src/lib/similarity.js");
const chunking = solutions ? await import("../../solutions/by-paragraph.js") : await import("../../src/steps/3-chunk.js");

describe("step 2 · turkishConfidential", () => {
  it("matches the Turkish footer and nothing else", () => {
    expect(confidential.turkishConfidential, "turkishConfidential is still undefined — write the rule").toBeInstanceOf(RegExp);
    expect(confidential.turkishConfidential!.test("GİZLİ – Yalnızca şirket içi kullanım içindir")).toBe(true);
    expect(confidential.turkishConfidential!.test("Gizli veriler şifrelenmelidir.")).toBe(false);
    expect(confidential.turkishConfidential!.test("CONFIDENTIAL – Internal use only")).toBe(false);
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

describe("step 3 · byParagraph (your turn)", () => {
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
  it("labels every chunk with the sections it touches", () => {
    const chunks = chunking.byParagraph(doc, 500);
    for (const c of chunks) expect(c.sections.length).toBeGreaterThan(0);
    expect(chunks[0]!.sections).toContain("1");
    // the second chunk starts in section 1 and runs into section 2: it must list both
    expect(chunks[1]!.sections).toEqual(["1", "2"]);
  });
});
