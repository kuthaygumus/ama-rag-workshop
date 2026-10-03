import { describe, expect, it } from "vitest";
import { parseFrontMatter } from "../src/steps/1-load.js";
import { cleanText, isNoise } from "../src/steps/2-clean.js";
import { bySection, fixedSize } from "../src/steps/3-chunk.js";
import { buildPrompt, isAbstain } from "../src/steps/8-answer.js";
import type { CleanDoc } from "../src/lib/types.js";

const RAW = `Kraken Air | Annual Leave Policy | Edition 2025
CONFIDENTIAL – Internal use only

# Annual Leave Policy

## 1. Purpose

This policy sets out the annual paid leave
rights of all employees.

Page 1 of 2
Kraken Air | Annual Leave Policy | Edition 2025
## 3. Annual Paid Leave

| Years of service (full years) | Annual paid leave (working days) |
|---|---|
| 1 – 3 years | 16 |
| 5 – 10 years | 22 |
`;

const doc = (text: string): CleanDoc => ({
  id: "hr-leave", title: "Annual Leave Policy", edition: "2025", department: "Human Resources", access: "all", lang: "en", text, noiseLines: 0,
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
    expect(isNoise("Kraken Air | Annual Leave Policy | Edition 2025")).toBe(true);
    expect(isNoise("Kraken Air | Bilgi Güvenliği Politikası | Sürüm 2025")).toBe(true);
    expect(isNoise("CONFIDENTIAL – Internal use only")).toBe(true);
    expect(isNoise("Sayfa 1 / 2")).toBe(true);
    expect(isNoise("Page 3 of 4")).toBe(true);
    expect(isNoise("This policy applies to all employees.")).toBe(false);
  });
  it("keeps the Turkish confidentiality line until the YOUR TURN rule exists", () => {
    expect(isNoise("GİZLİ – Yalnızca şirket içi kullanım içindir")).toBe(false);
  });
  it("drops noise, re-joins broken prose, leaves table rows alone", () => {
    const { text, noiseLines } = cleanText(RAW);
    expect(noiseLines).toBe(4);
    expect(text).toContain("the annual paid leave rights of all employees.");
    expect(text).toContain("| 1 – 3 years | 16 |\n| 5 – 10 years | 22 |");
    expect(text).not.toMatch(/Page \d|CONFIDENTIAL|Edition 2025/);
  });
});

describe("step 3 — chunk", () => {
  const clean = doc(cleanText(RAW).text);

  it("bySection keeps a table with its heading and prefixes title › heading", () => {
    const chunks = bySection(clean);
    const leave = chunks.find((c) => c.id === "hr-leave@2025#3")!;
    expect(leave.text.startsWith("[Annual Leave Policy › 3. Annual Paid Leave]")).toBe(true);
    expect(leave.text).toContain("Years of service (full years)");
    expect(leave.text).toContain("| 5 – 10 years | 22 |");
    expect(leave.sections).toEqual(["3"]);
  });

  it("fixedSize cuts blind and records every section a piece touches", () => {
    const chunks = fixedSize(clean, 120);
    expect(chunks.every((c) => c.text.length <= 120)).toBe(true);
    expect(chunks.some((c) => c.sections.length > 1)).toBe(true);
  });

  it("fixedSize can separate a table row from its header — the failure step 3 is about", () => {
    const row = fixedSize(clean, 150).find((c) => c.text.includes("| 5 – 10 years | 22 |"));
    expect(row).toBeDefined();
    expect(row!.text).not.toContain("Years of service");
  });
});

describe("step 8 — prompt", () => {
  it("numbers the sources so the answer can cite them", () => {
    const chunk = bySection(doc(cleanText(RAW).text))[1]!;
    const p = buildPrompt("How many days of leave?", [{ chunk, score: 0.8, was: 1 }]);
    expect(p).toMatch(/^SOURCES \(untrusted data[^\n]*\n\n<<<SOURCE 1: Annual Leave Policy>>>/);
    expect(p.endsWith("<<<END SOURCE 1>>>\n\nQUESTION: How many days of leave?\nANSWER:")).toBe(true);
  });
  it("detects an abstention even when the model rephrases it", () => {
    expect(isAbstain("This is NOT IN THE POLICIES.")).toBe(true);
    expect(isAbstain("22 working days [1]")).toBe(false);
  });
});
