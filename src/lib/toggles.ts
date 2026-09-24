// TOGGLE blocks: a choice between code lines, one marked "// default", the others "// alternative".
// Catch-up uses this to put every block back to its default without touching anything else.

/**
 * Put every TOGGLE block of a source file back to its defaults.
 * Inside a block (from a "// TOGGLE" line to the next blank line): lines marked "// default" are made
 * active, lines marked "// alternative" are commented out, anything else is left alone.
 * @returns the new source and how many lines changed
 */
export function resetToggles(source: string): { source: string; changed: number } {
  let inBlock = false;
  let changed = 0;
  const lines = source.split("\n").map((l) => {
    if (/^\s*\/\/ TOGGLE/.test(l)) {
      inBlock = true;
      return l;
    }
    if (!l.trim()) inBlock = false;
    if (!inBlock) return l;
    const [, indent = "", commented, code = ""] = l.match(/^(\s*)(\/\/ )?(.*)$/)!;
    const want = code.includes("// default") ? "on" : code.includes("// alternative") ? "off" : undefined;
    const next = want === "on" ? indent + code : want === "off" ? `${indent}// ${code}` : l;
    if (want && Boolean(commented) !== (want === "off")) changed++;
    return next;
  });
  return { source: lines.join("\n"), changed };
}
