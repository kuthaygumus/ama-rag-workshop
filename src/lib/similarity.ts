// How close are two vectors? Three common answers. The retriever uses cosine.

/**
 * Cosine similarity: the angle between two vectors, ignoring their length.
 * 1 = same direction (same meaning), 0 = unrelated, −1 = opposite.
 * @example cosine([1, 0], [2, 0]) // 1 — same direction, different length
 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Euclidean (L2) distance: the straight-line distance between the two points.
 * 0 = the same point; bigger = further apart. Note the direction: SMALLER is closer.
 * @example l2([0, 0], [3, 4]) // 5
 */
export function l2(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(sum);
}

/** Length of a vector. Step 4 prints it: bge-m3 vectors come out with length 1.000. */
export function norm(a: number[]): number {
  return Math.sqrt(a.reduce((s, x) => s + x * x, 0));
}

// ── YOUR TURN ───────────────────────────────────────────────────────────────────────────────────
// Write the sibling of cosine(): the dot product. Multiply the vectors element by element and sum.
// Unlike cosine it does NOT divide by the lengths. Then run: npm run check:sibling
// Question to answer afterwards: step 4 printed "norm 1.000" for every vector — so for OUR vectors,
// how does dot() compare to cosine()? Try it: npm run similar -- --metric dot

/**
 * Dot product: sum of a[i] × b[i].
 * @example dot([1, 2, 3], [4, 5, 6]) // 32
 */
export function dot(a: number[], b: number[]): number {
  throw new Error("dot() is not written yet — see the YOUR TURN note above it in src/lib/similarity.ts");
}
