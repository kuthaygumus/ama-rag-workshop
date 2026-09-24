// Squash 1024 dimensions down to 2 so we can draw them — PCA (principal component analysis).
// It finds the two directions along which our chunks differ the most and measures each chunk along them.
// Most of the information is lost on the way (we print how much survives); what survives is the
// coarse layout: which chunks sit near which.

export interface Pca {
  mean: number[];
  /** Two unit vectors in the original 1024-d space. */
  axes: [number[], number[]];
  /** Share of the total spread each axis keeps (0..1). */
  explained: [number, number];
  /** 2-D coordinates of every input vector. */
  coords: [number, number][];
}

const dotp = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** Top eigenvector of a symmetric matrix by power iteration (deterministic start). */
function topEigen(m: number[][]): { vec: number[]; val: number } {
  let v = m.map((_, i) => 1 + i / m.length);
  for (let it = 0; it < 300; it++) {
    const next = m.map((row) => dotp(row, v));
    const len = Math.sqrt(dotp(next, next)) || 1;
    v = next.map((x) => x / len);
  }
  return { vec: v, val: dotp(v, m.map((row) => dotp(row, v))) };
}

/**
 * Fit a 2-component PCA with the Gram-matrix trick (n×n instead of 1024×1024).
 * @param x one row per chunk vector
 */
export function pca2(x: number[][]): Pca {
  const n = x.length;
  const d = x[0]!.length;
  const mean = Array.from({ length: d }, (_, j) => x.reduce((s, r) => s + r[j]!, 0) / n);
  const c = x.map((r) => r.map((v, j) => v - mean[j]!));
  let g = c.map((ri) => c.map((rj) => dotp(ri, rj)));
  const trace = g.reduce((s, row, i) => s + row[i]!, 0);

  const axes: number[][] = [];
  const explained: number[] = [];
  for (let k = 0; k < 2; k++) {
    const { vec: u, val } = topEigen(g);
    let axis = Array.from({ length: d }, (_, j) => c.reduce((s, r, i) => s + r[j]! * u[i]!, 0) / Math.sqrt(val));
    // sign is arbitrary in PCA: fix it so every run (and every laptop) draws the same picture
    const biggest = axis.reduce((best, v) => (Math.abs(v) > Math.abs(best) ? v : best), 0);
    if (biggest < 0) axis = axis.map((v) => -v);
    axes.push(axis);
    explained.push(val / trace);
    g = g.map((row, i) => row.map((v, j) => v - val * u[i]! * u[j]!)); // remove this direction, find the next
  }
  const coords = c.map((r) => [dotp(r, axes[0]!), dotp(r, axes[1]!)] as [number, number]);
  return { mean, axes: [axes[0]!, axes[1]!], explained: [explained[0]!, explained[1]!], coords };
}

/** Where a new vector (e.g. the question) lands on the same two axes. */
export function project(p: Pca, v: number[]): [number, number] {
  const c = v.map((x, j) => x - p.mean[j]!);
  return [dotp(c, p.axes[0]), dotp(c, p.axes[1])];
}
