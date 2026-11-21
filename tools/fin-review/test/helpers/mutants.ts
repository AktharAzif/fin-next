// The guards of src/units/content.ts's image and font walks, each taken out on its own: the mutation
// pass of test/content-guards.test.ts, which shows that no check of a walk can be removed with the
// tests still green. A guard is an atomic condition of a check, found by reading the source's
// structure rather than by a list kept by hand, so a check added later is covered without anyone
// remembering to add it:
//
// - each condition of `if (...) return false;` (or `null`, or `""`): a refusal;
// - each condition of a `return` that gives a boolean (an acceptance), of the condition of a
//   `cond ? x : null` (or `null : x`) in a `return` or a `const`, and of a `for` loop's bound;
// - each operand of the `||` and `&&` chains in those, nested groups and negations included, and the
//   body of an `.every((x) => ...)` arrow inside one.
//
// A guard is taken out by putting in its place the value that lets more through: `false` for a part
// of a refusal, `true` for a part of an acceptance (a negation flips which). This is a lexer over
// one file whose layout the test knows, not a parser for any TypeScript: the test checks that it
// finds the guards it names, so a change it cannot read fails rather than passing with fewer.

/** One guard taken out: a stable key (the function, the condition and its ordinal there), the line, and the source without it. */
export interface Mutant {
  readonly key: string;
  readonly line: number;
  readonly source: string;
}

/** The top-level functions whose guards are not the walks' (the lockfile, source maps and the binary report). */
const NOT_WALKS: ReadonlySet<string> = new Set(["mediaFormat", "mediaKind", "looksLikeMedia", "isLockfile", "isSourceMap", "view"]);

/** `source` with comments and the insides of string, template and regex literals blanked (same length), so brackets and operators in them are not read. */
function masked(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let last = "";
  for (let i = 0; i < source.length; ) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const to = end < 0 ? source.length : end;
      blank(i, to);
      i = to;
    } else if (c === "/" && next === "*") {
      const to = source.indexOf("*/", i + 2) + 2;
      blank(i, to);
      i = to;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      last = c;
    } else if (c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\breturn\s*$/.test(source.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && (source[j] !== "/" || inClass)) {
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += source[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, j);
      i = j + 1;
      while (/[a-z]/.test(source[i] ?? "")) i++;
      last = "/";
    } else {
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out.join("");
}

/** The index of the bracket that closes the one at `open` in `text` (masked). */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`no closing bracket for ${open}`);
}

/** The top-level positions of `token` in `text` from `from` to `to` (masked), outside any bracket, up to a bracket that closes one opened before `from`. */
function topLevel(text: string, from: number, to: number, token: string): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth < 0) break;
    } else if (depth === 0 && text.startsWith(token, i)) {
      // `?` of `?.` and `??` is no conditional; `=>` is no comparison.
      if (token === "?" && (text[i + 1] === "?" || text[i + 1] === "." || text[i - 1] === "?")) continue;
      out.push(i);
      i += token.length - 1;
    }
  }
  return out;
}

/** The end of the statement from `from` (masked): its top-level `;`, or -1 when it ends at a bracket (a `for` loop's header). */
function statementEnd(text: string, from: number): number {
  return topLevel(text, from, text.length, ";")[0] ?? -1;
}

/** [from, to) trimmed of white space. */
function trimmed(text: string, from: number, to: number): [number, number] {
  while (from < to && /\s/.test(text[from] ?? "")) from++;
  while (to > from && /\s/.test(text[to - 1] ?? "")) to--;
  return [from, to];
}

interface Guard {
  readonly from: number;
  readonly to: number;
  /** The value that lets more through: false in a refusal, true in an acceptance. */
  readonly loosened: boolean;
}

/** The guards of the condition [from, to) (masked) whose being `loosened` lets more through. */
function guardsOf(text: string, from: number, to: number, loosened: boolean, out: Guard[]): void {
  [from, to] = trimmed(text, from, to);
  if (from >= to) return;
  for (const op of ["||", "&&"]) {
    const at = topLevel(text, from, to, op);
    if (at.length === 0) continue;
    let start = from;
    for (const split of [...at, to]) {
      guardsOf(text, start, split, loosened, out);
      start = split + op.length;
    }
    return;
  }
  // A ternary is one guard as a whole.
  if (topLevel(text, from, to, "?").length > 0) {
    out.push({ from, to, loosened });
    return;
  }
  if (text[from] === "(" && closing(text, from) === to - 1) {
    guardsOf(text, from + 1, to - 1, loosened, out);
    return;
  }
  out.push({ from, to, loosened });
  const negated = text[from] === "!";
  if (negated && text[from + 1] === "(" && closing(text, from + 1) === to - 1) {
    guardsOf(text, from + 2, to - 1, !loosened, out);
    return;
  }
  // The expression body of an `.every((x) => ...)` arrow in this guard.
  for (let at = text.indexOf(".every(", from); at >= 0 && at < to; at = text.indexOf(".every(", at + 1)) {
    const open = at + ".every".length;
    const close = closing(text, open);
    const arrow = text.indexOf("=>", open);
    if (arrow < 0 || arrow > close) continue;
    const [bodyFrom] = trimmed(text, arrow + 2, close);
    if (text[bodyFrom] === "{") continue;
    guardsOf(text, bodyFrom, close, negated ? !loosened : loosened, out);
  }
}

/** A `return` or `const` expression's condition when it is `cond ? x : null` (acceptance) or `cond ? null : x` (refusal). */
function ternaryGuards(source: string, text: string, from: number, to: number, out: Guard[]): boolean {
  const question = topLevel(text, from, to, "?")[0];
  if (question === undefined) return false;
  const colon = topLevel(text, question + 1, to, ":")[0];
  if (colon === undefined) return false;
  const yes = source.slice(question + 1, colon).trim();
  const no = source.slice(colon + 1, to).trim();
  if (no === "null" || no === "false") guardsOf(text, from, question, true, out);
  else if (yes === "null" || yes === "false") guardsOf(text, from, question, false, out);
  return true;
}

/** Every guard of `source` (content.ts) taken out on its own, in the order they occur. */
export function guardMutants(source: string): Mutant[] {
  const text = masked(source);
  const booleans = new Set([...source.matchAll(/^(?:export )?function (\w+)\([^)]*\): boolean \{/gm)].map((match) => match[1]));
  const functions = [...source.matchAll(/^(?:export )?function (\w+)\(/gm)].map((match) => ({ name: match[1] ?? "", at: match.index }));
  const functionAt = (at: number): string => functions.filter((fn) => fn.at <= at).at(-1)?.name ?? "";
  const guards: Guard[] = [];
  // Refusals: `if (cond) return false;`, `return null;` or `return "";`.
  for (const match of text.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closing(text, open);
    if (/^\s*return\s+(?:false|null|"")\s*;/.test(source.slice(close + 1))) guardsOf(text, open + 1, close, false, guards);
  }
  // Acceptances and conditional nulls in `return` and `const`.
  for (const match of text.matchAll(/\b(?:return|const|let)\s+/g)) {
    let from = match.index + match[0].length;
    const end = statementEnd(text, from);
    if (end < 0) continue;
    if (!match[0].startsWith("return")) {
      const assign = text.indexOf("=", from);
      if (assign < 0 || assign > end || text[assign + 1] === "=" || text[assign + 1] === ">") continue;
      from = assign + 1;
    }
    if (ternaryGuards(source, text, from, end, guards) || !match[0].startsWith("return")) continue;
    const expr = source.slice(from, end).trim();
    if (/^(?:true|false|null|""|\w+|\{[\s\S]*\})$/.test(expr)) continue;
    const call = /^(\w+)\(/.exec(expr)?.[1];
    const comparison = ["||", "&&", "===", "!==", "<=", ">=", "<", ">"].some((op) => topLevel(text, from, end, op).length > 0);
    if (comparison || expr.startsWith("!") || (call !== undefined && booleans.has(call)) || /\.every\(/.test(expr)) guardsOf(text, from, end, true, guards);
  }
  // A `for` loop's bounds joined with `&&`.
  for (const match of text.matchAll(/\bfor\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closing(text, open);
    const parts = topLevel(text, open + 1, close, ";");
    if (parts.length !== 2) continue;
    const [first, second] = parts as [number, number];
    if (topLevel(text, first + 1, second, "&&").length > 0) guardsOf(text, first + 1, second, true, guards);
  }
  const seen = new Map<string, number>();
  const out: Mutant[] = [];
  const unique = new Map<string, Guard>();
  for (const guard of guards) unique.set(`${guard.from}:${guard.to}`, guard);
  for (const guard of [...unique.values()].sort((a, b) => a.from - b.from || b.to - a.to)) {
    const name = functionAt(guard.from);
    if (NOT_WALKS.has(name)) continue;
    const condition = source.slice(guard.from, guard.to).replace(/\s+/g, " ");
    // The lockfile and source map branches of verifiedExclusion are not walks.
    if (/isLockfile|isSourceMap|pnpm-lock|"map"/.test(condition)) continue;
    const base = `${name}: ${condition}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    out.push({
      key: ordinal === 1 ? base : `${base} #${ordinal}`,
      line: source.slice(0, guard.from).split("\n").length,
      source: `${source.slice(0, guard.from)}${String(guard.loosened)}${source.slice(guard.to)}`,
    });
  }
  return out;
}
