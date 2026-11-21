// The guards of src/units/content.ts's image and font walks, each taken out on its own: the mutation
// pass of test/content-guards.test.ts, which shows that no check of a walk can be removed with the
// tests still green. A guard is an atomic condition of a check, found by reading the source's
// structure rather than by a list kept by hand, so a check added later is covered without anyone
// remembering to add it:
//
// - every `if` of a walk, which the reader classifies by what it guards and fails on when it cannot:
//   a refusal (`return false;`, `null` or `""`, bare or braced), a gate (a braced block that holds a
//   refusal: taking the condition out skips the block's checks), an acceptance (a `return` of
//   anything else) or a flag (`x = true;`), whose conditions are guards; or a step that checks
//   nothing (`continue`, `break`, a value assigned), whose condition picks a path and is no guard;
// - each condition of a `return` that gives a boolean (an acceptance), of the condition of a
//   `cond ? x : null` (or `null : x`) in a `return` or a `const`, and of a `for` loop's bound;
// - each operand of the `||` and `&&` chains in those, nested groups and negations included, the
//   body of an `.every((x) => ...)` arrow inside one, and each arm of a ternary: a ternary that is
//   a condition gives the guards of each arm, and a ternary inside a guard (a value it compares, an
//   argument) gives that guard taken out for one arm at a time;
// - each check a helper takes as an argument, at each call (the flags `fullBoxVersion` allows a box,
//   the bound of `cString` and of an EOT `field`, the padding `tiled` allows), set to allow
//   anything; a helper with a parameter named as a check (`max`, `flags`, `align`, ...) that
//   ARGUMENT_CHECKS does not list fails the reader.
//
// A guard is taken out by putting in its place the value that lets more through: `false` for a part
// of a refusal or a gate, `true` for a part of an acceptance or a flag (a negation flips which). A
// guard that calls a closure of its walk with a block body (one that moves the walk's position, such
// as `read` or `field`) keeps the call and drops only what it checks of the result. This is a lexer
// over one file whose layout the test knows, not a parser for any TypeScript: the test checks that it
// finds the guards it names, and the reader throws on a layout it cannot classify, so a change it
// cannot read fails rather than passing with fewer.

/** One guard taken out: a stable key (the function, the condition and its ordinal there), the line, and the source without it. */
export interface Mutant {
  readonly key: string;
  readonly line: number;
  readonly source: string;
}

/** The top-level functions whose guards are not the walks' (the lockfile, source maps and the binary report). */
const NOT_WALKS: ReadonlySet<string> = new Set(["mediaFormat", "mediaKind", "looksLikeMedia", "isLockfile", "isSourceMap", "view"]);

/** The lockfile and source map branches of verifiedExclusion are not walks. */
const NOT_WALK_CONDITION_RE = /isLockfile|isSourceMap|pnpm-lock|"map"/;

/** The names a helper's parameter has when it is a check its caller sets (a bound, the flags allowed, the padding allowed). */
const CHECK_PARAMETERS: ReadonlySet<string> = new Set(["max", "flags", "align", "limit", "allowed"]);

/**
 * The helpers that take a check as an argument: which argument (the last, which a call may leave
 * out for its default), the value that lets everything through, and what the mutant says it does.
 */
const ARGUMENT_CHECKS: Readonly<Record<string, { readonly index: number; readonly loosened: string; readonly note: (args: readonly string[]) => string }>> = {
  fullBoxVersion: { index: 2, loosened: "0xffffff", note: (args) => `every flag of ${args[1] ?? ""}` },
  cString: { index: 3, loosened: "Infinity", note: () => "no bound" },
  field: { index: 0, loosened: "Infinity", note: () => "no bound" },
  tiled: { index: 3, loosened: "Infinity", note: () => "any zero padding" },
};

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

/** The index of the unmatched bracket that opens the group holding `at` (masked), or -1 when none does after `from`. */
function opening(text: string, from: number, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= from; i--) {
    const c = text[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** True when `?` at `i` of `text` starts no conditional: `?.`, `??` and the second `?` of `??`. */
function notConditional(text: string, i: number): boolean {
  return text[i + 1] === "?" || text[i + 1] === "." || text[i - 1] === "?";
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
      if (token === "?" && notConditional(text, i)) continue;
      out.push(i);
      i += token.length - 1;
    }
  }
  return out;
}

/** The first top-level conditional of [from, to) (masked): its `?` and the `:` that matches it, or null. */
function ternaryAt(text: string, from: number, to: number): { question: number; colon: number } | null {
  const question = topLevel(text, from, to, "?")[0];
  if (question === undefined) return null;
  let nested = 0;
  let depth = 0;
  for (let i = question + 1; i < to; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?" && !notConditional(text, i)) nested++;
    else if (depth === 0 && c === ":") {
      if (nested === 0) return { question, colon: i };
      nested--;
    }
  }
  throw new Error(`a conditional with no ":" at ${question}`);
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
  /** What takes the guard's place: the value that lets more through, kept calls first. */
  readonly replacement: string;
  /** Which form of the guard this is, when not the guard taken out whole (an arm, a box's flags). */
  readonly note: string | null;
}

/** The source and what the reader knows of it. */
interface Reader {
  readonly source: string;
  readonly text: string;
  /** The closures of the walks with a block body: a call to one moves the walk's position. */
  readonly moving: ReadonlySet<string>;
}

/** The names of a parameter list's parameters (`a: T, b = 0, c: Array<[x, y]>` gives a, b, c). */
function parameters(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= list.length; i++) {
    const c = list[i];
    if (c === "<" || c === "[" || c === "{" || c === "(") depth++;
    else if (c === ">" || c === "]" || c === "}" || c === ")") depth--;
    else if (i === list.length || (c === "," && depth === 0)) {
      out.push(/^\s*(\w+)/.exec(list.slice(start, i))?.[1] ?? "");
      start = i + 1;
    }
  }
  return out;
}

/** The calls to a closure that moves the walk's position in [from, to), in order, as the source spells them. */
function movingCalls(r: Reader, from: number, to: number): string[] {
  const out: string[] = [];
  for (const match of r.text.slice(from, to).matchAll(/\b(\w+)\s*\(/g)) {
    if (!r.moving.has(match[1] ?? "")) continue;
    const at = from + match.index;
    const open = at + match[0].length - 1;
    out.push(r.source.slice(at, closing(r.text, open) + 1));
  }
  return out;
}

/** The value that takes out the guard [from, to): `loosened`, after any call in it that moves the walk's position. */
function takenOut(r: Reader, from: number, to: number, loosened: boolean): string {
  const calls = movingCalls(r, from, to);
  return calls.length === 0 ? String(loosened) : `(${calls.join(", ")}, ${loosened})`;
}

/** The spans of [from, to) (masked) inside an arrow function's body: a conditional there is the arrow's, read with its body. */
function arrowBodies(text: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = text.indexOf("=>", from); at >= 0 && at < to; at = text.indexOf("=>", at + 2)) {
    let depth = 0;
    let end = to;
    for (let i = at + 2; i < to; i++) {
      const c = text[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (--depth < 0) {
          end = i;
          break;
        }
      } else if (depth === 0 && c === ",") {
        end = i;
        break;
      }
    }
    out.push([at, end]);
  }
  return out;
}

/** Each conditional inside the guard [from, to) (masked), not at its top level and not in an arrow's body: its condition, as the source spells it. */
function innerConditions(r: Reader, from: number, to: number): string[] {
  const out: string[] = [];
  const arrows = arrowBodies(r.text, from, to);
  for (let i = from; i < to; i++) {
    if (r.text[i] !== "?" || notConditional(r.text, i) || arrows.some(([a, b]) => i > a && i < b)) continue;
    const open = opening(r.text, from, i);
    if (open < 0) throw new Error(`a conditional at the top of a guard at ${i}: read it as a ternary first`);
    if (r.text[open] === "{") throw new Error(`a conditional in an object literal at ${i}`);
    const commas = topLevel(r.text, open + 1, i, ",");
    const start = commas.length === 0 ? open + 1 : (commas[commas.length - 1] ?? open) + 1;
    const condition = r.source.slice(start, i).trim();
    if (/(?:^|[^=!<>])=(?!=)|=>/.test(r.text.slice(start, i)) || movingCalls(r, start, i).length > 0) {
      throw new Error(`a conditional whose condition assigns or moves the walk at ${i}: ${condition}`);
    }
    out.push(condition);
  }
  return out;
}

/** The guards of the condition [from, to) (masked) whose being `loosened` lets more through. */
function guardsOf(r: Reader, from: number, to: number, loosened: boolean, out: Guard[]): void {
  const { text, source } = r;
  [from, to] = trimmed(text, from, to);
  if (from >= to) return;
  // A conditional binds loosest: each arm's guards in turn (its condition only picks an arm).
  const ternary = ternaryAt(text, from, to);
  if (ternary !== null) {
    guardsOf(r, ternary.question + 1, ternary.colon, loosened, out);
    guardsOf(r, ternary.colon + 1, to, loosened, out);
    return;
  }
  for (const op of ["||", "&&"]) {
    const at = topLevel(text, from, to, op);
    if (at.length === 0) continue;
    let start = from;
    for (const split of [...at, to]) {
      guardsOf(r, start, split, loosened, out);
      start = split + op.length;
    }
    return;
  }
  if (text[from] === "(" && closing(text, from) === to - 1) {
    guardsOf(r, from + 1, to - 1, loosened, out);
    return;
  }
  out.push({ from, to, replacement: takenOut(r, from, to, loosened), note: null });
  // A conditional inside the guard (a value it compares, an argument): the guard taken out for one arm at a time.
  const conditions = innerConditions(r, from, to);
  if (conditions.length > 0 && movingCalls(r, from, to).length > 0) throw new Error(`a guard with a conditional and a call that moves the walk at ${from}`);
  const guard = source.slice(from, to);
  for (const condition of conditions) {
    out.push({ from, to, replacement: `((${condition}) ? ${loosened} : (${guard}))`, note: `when ${condition}` });
    out.push({ from, to, replacement: `((${condition}) ? (${guard}) : ${loosened})`, note: `unless ${condition}` });
  }
  const negated = text[from] === "!";
  if (negated && text[from + 1] === "(" && closing(text, from + 1) === to - 1) {
    guardsOf(r, from + 2, to - 1, !loosened, out);
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
    guardsOf(r, bodyFrom, close, negated ? !loosened : loosened, out);
  }
}

/** A `return` or `const` expression's condition when it is `cond ? x : null` (acceptance) or `cond ? null : x` (refusal). */
function ternaryGuards(r: Reader, from: number, to: number, out: Guard[]): boolean {
  const ternary = ternaryAt(r.text, from, to);
  if (ternary === null) return false;
  const yes = r.source.slice(ternary.question + 1, ternary.colon).trim();
  const no = r.source.slice(ternary.colon + 1, to).trim();
  if (no === "null" || no === "false") guardsOf(r, from, ternary.question, true, out);
  else if (yes === "null" || yes === "false") guardsOf(r, from, ternary.question, false, out);
  return true;
}

const REFUSAL_RE = /^return\s+(?:false|null|"")$/;

/**
 * What the statement after an `if`'s condition (from `at`, masked) does, so its condition's guards
 * can be taken out the way that lets more through: `refusal` and `gate` (a braced block that holds
 * a refusal) take `false`, `acceptance` (a `return` of anything else) and `flag` (`x = true;`) take
 * `true`, and `step` (`continue`, `break` or a value assigned) checks nothing. Throws on anything else.
 */
function consequent(r: Reader, at: number, line: number): "refusal" | "gate" | "acceptance" | "flag" | "step" {
  const [start] = trimmed(r.text, at, r.text.length);
  if (r.text[start] === "{") {
    const end = closing(r.text, start);
    const statements = r.source
      .slice(start + 1, end)
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (statements.length === 1 && REFUSAL_RE.test(statements[0] ?? "")) return "refusal";
    if (/\breturn\s+(?:false|null|"")\s*;/.test(r.source.slice(start + 1, end))) return "gate";
    const last = statements[statements.length - 1] ?? "";
    if (!/\breturn\b/.test(r.text.slice(start + 1, end)) && (last === "continue" || last === "break")) return "step";
    throw new Error(`content.ts:${line}: an if whose block the reader cannot classify: ${r.source.slice(start, end + 1).replace(/\s+/g, " ")}`);
  }
  const end = statementEnd(r.text, start);
  const statement = r.source.slice(start, end < 0 ? start : end).trim();
  if (REFUSAL_RE.test(statement)) return "refusal";
  if (/^return\b/.test(statement)) return "acceptance";
  if (/^\w+\s*=\s*true$/.test(statement)) return "flag";
  if (statement === "continue" || statement === "break" || /^\w+\s*=\s*[^=]/.test(statement)) return "step";
  throw new Error(`content.ts:${line}: an if whose statement the reader cannot classify: ${statement}`);
}

/** Every guard of `source` (content.ts) taken out on its own, in the order they occur. */
export function guardMutants(source: string): Mutant[] {
  const text = masked(source);
  const moving = new Set([...source.matchAll(/\bconst (\w+) = \([^()]*\)(?::[^=]*)?=>\s*\{/g)].map((match) => match[1] ?? ""));
  const r: Reader = { source, text, moving };
  const booleans = new Set([...source.matchAll(/^(?:export )?function (\w+)\([^)]*\): boolean \{/gm)].map((match) => match[1]));
  const functions = [...source.matchAll(/^(?:export )?function (\w+)\(/gm)].map((match) => ({ name: match[1] ?? "", at: match.index }));
  const functionAt = (at: number): string => functions.filter((fn) => fn.at <= at).at(-1)?.name ?? "";
  const lineAt = (at: number): number => source.slice(0, at).split("\n").length;
  const guards: Guard[] = [];
  // Every `if` of a walk, by what its statement does.
  for (const match of text.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closing(text, open);
    if (NOT_WALKS.has(functionAt(open)) || NOT_WALK_CONDITION_RE.test(source.slice(open, close))) continue;
    const kind = consequent(r, close + 1, lineAt(open));
    if (kind === "refusal" || kind === "gate") guardsOf(r, open + 1, close, false, guards);
    else if (kind === "acceptance" || kind === "flag") guardsOf(r, open + 1, close, true, guards);
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
    if (ternaryGuards(r, from, end, guards) || !match[0].startsWith("return")) continue;
    const expr = source.slice(from, end).trim();
    if (/^(?:true|false|null|""|\w+|\{[\s\S]*\})$/.test(expr)) continue;
    const call = /^(\w+)\(/.exec(expr)?.[1];
    const comparison = ["||", "&&", "===", "!==", "<=", ">=", "<", ">"].some((op) => topLevel(text, from, end, op).length > 0);
    if (comparison || expr.startsWith("!") || (call !== undefined && booleans.has(call)) || /\.every\(/.test(expr)) guardsOf(r, from, end, true, guards);
  }
  // A `for` loop's bounds joined with `&&`.
  for (const match of text.matchAll(/\bfor\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closing(text, open);
    const parts = topLevel(text, open + 1, close, ";");
    if (parts.length !== 2) continue;
    const [first, second] = parts as [number, number];
    if (topLevel(text, first + 1, second, "&&").length > 0) guardsOf(r, first + 1, second, true, guards);
  }
  // A check passed as an argument: each call of a helper that takes one, with that argument letting
  // everything through. A parameter that names a check of a helper not listed fails here.
  for (const match of source.matchAll(/(?:\bfunction (\w+)|\bconst (\w+) = )\(([^()]*)\)/g)) {
    const name = match[1] ?? match[2] ?? "";
    const params = parameters(match[3] ?? "");
    const checks = params.filter((param) => CHECK_PARAMETERS.has(param));
    if (checks.length > 0 && ARGUMENT_CHECKS[name]?.index !== params.indexOf(checks[0] ?? "")) {
      throw new Error(`content.ts:${lineAt(match.index)}: ${name} takes ${checks.join(", ")}, a check the reader does not take out`);
    }
  }
  for (const [helper, check] of Object.entries(ARGUMENT_CHECKS)) {
    for (const match of text.matchAll(new RegExp(`\\b${helper}\\(`, "g"))) {
      if (/\bfunction\s+$/.test(text.slice(Math.max(0, match.index - 16), match.index))) continue;
      const open = match.index + match[0].length - 1;
      const close = closing(text, open);
      const ends = [...topLevel(text, open + 1, close, ","), close];
      const args = ends.map((end, index) => source.slice(index === 0 ? open + 1 : (ends[index - 1] ?? open) + 1, end).trim());
      if (args.length < check.index || args.length > check.index + 1) throw new Error(`content.ts:${lineAt(open)}: a call of ${helper} the reader cannot classify`);
      const loosened = [...args.slice(0, check.index), check.loosened];
      guards.push({ from: match.index, to: close + 1, replacement: `${helper}(${loosened.join(", ")})`, note: check.note(args) });
    }
  }
  const seen = new Map<string, number>();
  const out: Mutant[] = [];
  const unique = new Map<string, Guard>();
  for (const guard of guards) unique.set(`${guard.from}:${guard.to}:${guard.replacement}`, guard);
  for (const guard of [...unique.values()].sort((a, b) => a.from - b.from || b.to - a.to)) {
    const name = functionAt(guard.from);
    if (NOT_WALKS.has(name)) continue;
    const condition = source.slice(guard.from, guard.to).replace(/\s+/g, " ");
    if (NOT_WALK_CONDITION_RE.test(condition)) continue;
    const base = `${name}: ${condition}${guard.note === null ? "" : ` [${guard.note}]`}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    out.push({
      key: ordinal === 1 ? base : `${base} #${ordinal}`,
      line: lineAt(guard.from),
      source: `${source.slice(0, guard.from)}${guard.replacement}${source.slice(guard.to)}`,
    });
  }
  return out;
}
