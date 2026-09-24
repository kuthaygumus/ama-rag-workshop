// The records that travel from step to step. Open any data/*.json file and you will see these shapes.

/** Metadata a document carries in its front matter. Ids come from here, never from file paths. */
export interface DocMeta {
  id: string;
  title: string;
  /** Always a string ("2025"), never a number: metadata filters compare strings. */
  edition: string;
  department: string;
  /** "all" or "hr-only" — checked at question time, see step 6. */
  access: string;
  lang: string;
}

/** Step 1 output: one file from corpus/<edition>/, front matter parsed, body untouched. */
export interface Doc extends DocMeta {
  path: string;
  body: string;
}

/** Step 2 output: the same document with extraction noise removed. */
export interface CleanDoc extends DocMeta {
  text: string;
  noiseLines: number;
}

/** Step 3 output: one piece of one document — the unit we embed, store, retrieve and cite. */
export interface Chunk {
  /** "hr-leave@2025#3" — document, edition, position. */
  id: string;
  docId: string;
  edition: string;
  title: string;
  access: string;
  lang: string;
  /** Section numbers this chunk touches ("3", or "2","3" when a blind cut crosses a heading). */
  sections: string[];
  text: string;
}

/** Step 4 output: a chunk plus its embedding. */
export interface VectorChunk extends Chunk {
  vector: number[];
}

/** One search result: a chunk and how close it is to the question (cosine similarity, 1 = same direction). */
export interface Hit {
  chunk: Chunk;
  score: number;
}

/** Metadata conditions applied during the search, not after it. */
export interface Filter {
  edition?: string;
  access?: string[];
}
