// Every step prints the same five lines, so the room always knows where to look:
//
//   ━━ STEP 3/8 · CHUNK
//      IN    what the step read
//      WHAT  what it did to it
//      OUT   what came out (counts + a sample or two)
//      TIME  how long it took → where the output was written

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = paint("1");
export const dim = paint("2");
export const green = paint("32");
export const yellow = paint("33");
export const red = paint("31");
export const cyan = paint("36");

/**
 * Print the step header.
 * @example stepHeader(3, "chunk") // ━━ STEP 3/8 · CHUNK
 */
export function stepHeader(step: number | string, name: string): void {
  console.log(`\n${bold(`━━ STEP ${step}/8 · ${name.toUpperCase()}`)}`);
}

/** Print a section header for tools that are not numbered steps (doctor, eval, similar …). */
export function banner(title: string): void {
  console.log(`\n${bold(`━━ ${title}`)}`);
}

/** Print one labelled line of the log contract (IN, WHAT, OUT, TIME) or any key/value pair. */
export function line(label: string, value: string | number): void {
  console.log(`   ${label.padEnd(5)} ${value}`);
}

/** Print a continuation line under the previous label (samples, table rows). */
export function more(text: string): void {
  console.log(`         ${text}`);
}

/** Print the closing TIME line: how long, and which file the participant should open next. */
export function done(t0: number, output?: string): void {
  const ms = Math.round(performance.now() - t0);
  line("TIME", output ? `${ms} ms  →  ${output}` : `${ms} ms`);
}

/**
 * Squash whitespace and cut a text to one readable line.
 * @param text any text, may contain newlines
 * @param max maximum characters, including the ellipsis
 * @example preview("a\n  b   c", 5) // "a b c"
 */
export function preview(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
