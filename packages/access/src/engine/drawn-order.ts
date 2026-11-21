// The order a name's characters are drawn in, for the role editor's reading of a name
// (src/engine/role-editor.ts). Inside Latin text a run of letters of a script written right to
// left (Hebrew, Arabic, N'Ko and others) is drawn right to left, so two such letters that read as
// Latin ones are seen in the opposite order from the one they are stored in. `drawnOrder` puts a
// text's characters in the order they are drawn, by Unicode's bidirectional algorithm (UAX #9) in
// the simple form a name needs: no explicit embeddings or isolates (their controls draw as nothing,
// which the role editor refuses and its reading removes), every digit a number, and a mark kept
// with the character before it.
//
// RIGHT_TO_LEFT lists the code points whose Bidi_Class is R or AL (DerivedBidiClass.txt 18.0.0,
// with its defaults for the unassigned code points of right-to-left blocks), merged across the
// marks, format characters and unassigned code points between them, which are classed before the
// list is read. The data is derived from Unicode's data files under the Unicode License v3, whose
// notice src/engine/unicode-look-alikes.ts carries.

const RIGHT_TO_LEFT_VERSION = "18.0.0";

const RIGHT_TO_LEFT_RANGES: readonly string[] = Object.freeze([
  "590-5ff 608 60b 60d 61b-64a 66d-6d5 6e5-6e6 6ee-6ef 6fa-7f5 7fa-8c9 200f fb1d-fb28 fb2a-fbc2",
  "fbd3-fd3d fd50-fd8f fd92-fdc7 fdf0-fdfc fe70-fefe 10800-1091e 10920-10b38 10b40-10d2f",
  "10d3a-10d3f 10d4a-10d68 10d6f-10e5f 10e7f-10eca 10ed9-10fff 1e800-1eeef 1eef2-1efff",
]);

export { RIGHT_TO_LEFT_RANGES, RIGHT_TO_LEFT_VERSION };

const RANGES: readonly (readonly [number, number])[] = RIGHT_TO_LEFT_RANGES.join(" ")
  .split(" ")
  .map((item) => {
    const [from = "", to = from] = item.split("-");
    return [Number.parseInt(from, 16), Number.parseInt(to, 16)] as const;
  });

/** Whether a character is written right to left (Bidi_Class R or AL, a mark aside). */
export function isRightToLeft(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  let low = 0;
  let high = RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [from, to] = RANGES[middle] ?? [0, -1];
    if (cp < from) high = middle - 1;
    else if (cp > to) low = middle + 1;
    else return true;
  }
  return false;
}

type Direction = "ltr" | "rtl";
type Kind = Direction | "number" | "neutral";

/** A character's kind: right to left, a number, left to right (a letter), or neutral. */
function kindOf(char: string): Kind {
  if (isRightToLeft(char)) return "rtl";
  if (/^\p{N}$/u.test(char)) return "number";
  if (/^\p{L}$/u.test(char)) return "ltr";
  return "neutral";
}

/**
 * The text's characters in the order they are drawn on a line whose direction is `line`: a mark
 * stays after the character it is drawn on; a number after left-to-right text (or at the start of
 * a left-to-right line) is left to right; a run of neutral characters takes the direction of the
 * text on both sides when they agree (a number counting as right to left), and the line's
 * otherwise; and each run of right-to-left characters, and each number inside it, is drawn
 * reversed (UAX #9's rules W1, W7, N1, N2, I1, I2 and L2).
 */
export function drawnOrder(text: string, line: Direction): string {
  const clusters: string[] = [];
  for (const char of text) {
    const last = clusters.length - 1;
    if (last >= 0 && /^\p{M}$/u.test(char)) clusters[last] += char;
    else clusters.push(char);
  }
  const kinds = clusters.map(kindOf);
  if (line === "ltr" && !kinds.includes("rtl")) return text;
  let strong: Direction = line;
  for (const [i, kind] of kinds.entries()) {
    if (kind === "ltr" || kind === "rtl") strong = kind;
    else if (kind === "number" && strong === "ltr") kinds[i] = "ltr";
  }
  const sideOf = (kind: Kind | undefined): Direction =>
    kind === undefined ? line : kind === "number" ? "rtl" : (kind as Direction);
  for (let i = 0; i < kinds.length; ) {
    if (kinds[i] !== "neutral") {
      i++;
      continue;
    }
    let end = i;
    while (kinds[end] === "neutral") end++;
    const before = sideOf(kinds[i - 1]);
    const resolved = before === sideOf(kinds[end]) ? before : line;
    kinds.fill(resolved, i, end);
    i = end;
  }
  const levels = kinds.map((kind) => {
    if (kind === "rtl") return 1;
    if (kind === "number") return 2;
    return line === "ltr" ? 0 : 2;
  });
  const order = clusters.map((_, i) => i);
  for (let level = Math.max(0, ...levels); level >= 1; level--) {
    for (let i = 0; i < order.length; ) {
      if ((levels[order[i] ?? 0] ?? 0) < level) {
        i++;
        continue;
      }
      let end = i;
      while (end < order.length && (levels[order[end] ?? 0] ?? 0) >= level) end++;
      order.splice(i, end - i, ...order.slice(i, end).reverse());
      i = end;
    }
  }
  return order.map((i) => clusters[i]).join("");
}
