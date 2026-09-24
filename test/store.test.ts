// One suite, both stores: whatever the JSON store does, Chroma must do the same.
import { afterAll, describe, expect, it } from "vitest";
import { ChromaStore, heartbeat, toWhere } from "../src/lib/chroma.js";
import { JsonStore } from "../src/lib/store-json.js";
import type { VectorStore } from "../src/lib/store.js";
import type { VectorChunk } from "../src/lib/types.js";

const rec = (id: string, edition: string, access: string, vector: number[]): VectorChunk => ({
  id: `${id}@${edition}#1`, docId: id, edition, title: id, access, lang: "tr", sections: ["1"], text: `${id} ${edition}`, vector,
});
const RECORDS_2025 = [rec("a", "2025", "all", [1, 0, 0]), rec("b", "2025", "all", [0.8, 0.6, 0]), rec("s", "2025", "hr-only", [0.9, 0.1, 0])];
const RECORDS_2026 = [rec("a", "2026", "all", [1, 0.05, 0])];

const chromaUp = await heartbeat();
const stores: [string, () => VectorStore, boolean][] = [
  ["json", () => new JsonStore("data/.test-store.json"), false],
  ["chroma", () => new ChromaStore("test-store-suite"), !chromaUp],
];

describe.each(stores)("%s store", (_name, make, skip) => {
  const store = make();
  afterAll(() => store.reset());

  it.skipIf(skip)("replaces one edition and keeps the others", async () => {
    await store.reset();
    await store.replaceEdition("2025", RECORDS_2025);
    await store.replaceEdition("2026", RECORDS_2026);
    await store.replaceEdition("2025", RECORDS_2025);
    expect(await store.count()).toBe(4);
    expect(await store.editions()).toEqual(["2025", "2026"]);
  });

  it.skipIf(skip)("ranks by cosine, best first", async () => {
    const hits = await store.query([1, 0, 0], 3, { edition: "2025" });
    expect(hits.map((h) => h.chunk.docId)).toEqual(["a", "s", "b"]);
    expect(hits[0]!.score).toBeCloseTo(1, 4);
    expect(hits[0]!.chunk.sections).toEqual(["1"]);
  });

  it.skipIf(skip)("filters on edition and access inside the search", async () => {
    const hits = await store.query([1, 0, 0], 5, { edition: "2025", access: ["all"] });
    expect(hits.map((h) => h.chunk.docId)).toEqual(["a", "b"]);
    const latest = await store.query([1, 0, 0], 5, { edition: "2026" });
    expect(latest.map((h) => h.chunk.id)).toEqual(["a@2026#1"]);
  });
});

describe("toWhere", () => {
  it("uses $and only for two or more conditions", () => {
    expect(toWhere({})).toBeUndefined();
    expect(toWhere({ edition: "2026" })).toEqual({ edition: "2026" });
    expect(toWhere({ edition: "2026", access: ["all"] })).toEqual({ $and: [{ edition: "2026" }, { access: { $in: ["all"] } }] });
  });
});
