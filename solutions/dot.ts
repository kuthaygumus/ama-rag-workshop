// Solution — lib/similarity.ts, YOUR TURN: the dot product.
// For vectors of length 1 (bge-m3 gives exactly that) dot() === cosine(): the division by the
// lengths divides by 1. That is why many vector databases offer "dot" as the fast cosine.
export function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}
