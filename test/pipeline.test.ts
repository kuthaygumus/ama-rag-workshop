import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "../src/steps/1-load.js";
import { cleanText, isNoise } from "../src/steps/2-clean.js";
import { bySection, fixedSize } from "../src/steps/3-chunk.js";
import { buildPrompt, isAbstain } from "../src/steps/8-answer.js";
import type { CleanDoc } from "../src/lib/types.js";

const RAW = `Kraken Air | Yıllık İzin Politikası | Sürüm 2025
GİZLİ – Yalnızca şirket içi kullanım içindir

# Yıllık İzin Politikası

## 1. Amaç

Bu politika tüm çalışanların yıllık ücretli izin
haklarını tanımlar.

Sayfa 1 / 2
Kraken Air | Yıllık İzin Politikası | Sürüm 2025
## 3. Yıllık Ücretli İzin

| Kıdem (tam yıl) | Yıllık ücretli izin (iş günü) |
|---|---|
| 1 – 3 yıl | 16 |
| 5 – 10 yıl | 22 |
`;

const doc = (text: string): CleanDoc => ({
  id: "hr-leave", title: "Yıllık İzin Politikası", edition: "2025", department: "İK", access: "all", lang: "tr", text, noiseLines: 0,
});

describe("step 1 — front matter", () => {
  it("parses key: value lines and unquotes the edition", () => {
    const { meta, body } = parseFrontMatter('---\nid: hr-leave\nedition: "2025"\naccess: hr-only\n---\n# Title\n');
    expect(meta).toEqual({ id: "hr-leave", edition: "2025", access: "hr-only" });
    expect(body).toBe("# Title\n");
  });
  it("returns the whole text as body when there is no front matter", () => {
    expect(parseFrontMatter("# Just text").body).toBe("# Just text");
  });
});

describe("step 2 — clean", () => {
  it("recognises page headers, footers and page numbers as noise", () => {
    expect(isNoise("Kraken Air | Yıllık İzin Politikası | Sürüm 2025")).toBe(true);
    expect(isNoise("GİZLİ – Yalnızca şirket içi kullanım içindir")).toBe(true);
    expect(isNoise("Sayfa 1 / 2")).toBe(true);
    expect(isNoise("Page 3 of 4")).toBe(true);
    expect(isNoise("Bu politika tüm çalışanlar için geçerlidir.")).toBe(false);
  });
  it("drops noise, re-joins broken prose, leaves table rows alone", () => {
    const { text, noiseLines } = cleanText(RAW);
    expect(noiseLines).toBe(4);
    expect(text).toContain("yıllık ücretli izin haklarını tanımlar.");
    expect(text).toContain("| 1 – 3 yıl | 16 |\n| 5 – 10 yıl | 22 |");
    expect(text).not.toMatch(/Sayfa|GİZLİ|Sürüm 2025/);
  });
});

describe("step 3 — chunk", () => {
  const clean = doc(cleanText(RAW).text);

  it("bySection keeps a table with its heading and prefixes title › heading", () => {
    const chunks = bySection(clean);
    const leave = chunks.find((c) => c.id === "hr-leave@2025#3")!;
    expect(leave.text.startsWith("[Yıllık İzin Politikası › 3. Yıllık Ücretli İzin]")).toBe(true);
    expect(leave.text).toContain("Kıdem (tam yıl)");
    expect(leave.text).toContain("| 5 – 10 yıl | 22 |");
    expect(leave.sections).toEqual(["3"]);
  });

  it("fixedSize cuts blind and records every section a piece touches", () => {
    const chunks = fixedSize(clean, 120);
    expect(chunks.every((c) => c.text.length <= 120)).toBe(true);
    expect(chunks.some((c) => c.sections.length > 1)).toBe(true);
  });

  it("fixedSize can separate a table row from its header — the failure step 3 is about", () => {
    const row = fixedSize(clean, 150).find((c) => c.text.includes("| 5 – 10 yıl | 22 |"));
    expect(row).toBeDefined();
    expect(row!.text).not.toContain("Kıdem (tam yıl)");
  });
});

describe("step 8 — prompt", () => {
  it("numbers the sources so the answer can cite them", () => {
    const chunk = bySection(doc(cleanText(RAW).text))[1]!;
    const p = buildPrompt("İzin kaç gün?", [{ chunk, score: 0.8, was: 1 }]);
    expect(p).toMatch(/^KAYNAKLAR \(güvenilmeyen veri[^\n]*\n\n<<<KAYNAK 1: Yıllık İzin Politikası>>>/);
    expect(p.endsWith("SORU: İzin kaç gün?\nCEVAP:")).toBe(true);
  });
  it("detects an abstention even when the model rephrases it", () => {
    expect(isAbstain("Bu bilgi politikalarda YER ALMIYOR.")).toBe(true);
    expect(isAbstain("22 iş günü [1]")).toBe(false);
  });
});
