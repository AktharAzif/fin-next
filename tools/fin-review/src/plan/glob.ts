// Path globs for tools/layout.json tiers, control paths and the CI path classes.
//
// `**` as a whole segment matches any number of directories (and, at the end, anything below);
// `*` matches within one segment; `?` one character of a segment. Nothing else is special, and a
// pattern with any other punctuation is refused rather than guessed at. Matching ignores ASCII
// case (spec 07 §2.4: one build machine's file system does) and treats a newline in a path as an
// ordinary character.
//
// That file system folds more than ASCII (U+017F to s, U+212A to k, Unicode normalisation), and
// no fold here can promise to be the same as every disk's. So the planner places only plain paths
// (printable ASCII, isPlainPath) and counts any other path as tier S and unmapped; every fold of
// the planner is foldAscii, the one these globs use.

import { shownText } from "../display.ts";

const GLOB_CHARS_RE = /^[A-Za-z0-9_.@+\-*?/]+$/;
const PLAIN_PATH_RE = /^[\x20-\x7e]*$/;

/**
 * True when `path` holds only printable ASCII (U+0020 to U+007E). A path with any other character
 * may name another path on a case-folding or normalising file system, so it cannot be placed.
 */
export function isPlainPath(path: string): boolean {
  return PLAIN_PATH_RE.test(path);
}

/** Folds ASCII letters only, as the globs do; the length (and so every slice offset) is kept. */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export interface Glob {
  readonly pattern: string;
  /** Matches ignoring ASCII case, as the build machine's disk does. */
  readonly test: (path: string) => boolean;
  /** Matches with every letter in the pattern's own case, as a case-sensitive disk (and pnpm on it) does. */
  readonly exact: (path: string) => boolean;
}

/** Why `pattern` is not a glob this module accepts, or null when it is. */
export function globError(pattern: unknown): string | null {
  if (typeof pattern !== "string" || pattern === "") return "a glob must be a non-empty string";
  if (!GLOB_CHARS_RE.test(pattern))
    return `glob ${shownText(pattern, 200)} uses a character other than letters, digits, _ . @ + - * ? and /`;
  const segments = pattern.split("/");
  for (const segment of segments) {
    if (segment === "") return `glob ${shownText(pattern, 200)} has an empty segment`;
    if (segment === "." || segment === "..")
      return `glob ${shownText(pattern, 200)} has a . or .. segment`;
    if (segment.includes("**") && segment !== "**")
      return `glob ${shownText(pattern, 200)} uses ** inside a segment`;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}

function segmentSource(segment: string): string {
  if (segment === "*") return "[^/]+";
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += escapeRegExp(ch);
  }
  return out;
}

/** Compiles a glob. Throws TypeError for a pattern globError refuses. */
export function compileGlob(pattern: string): Glob {
  const error = globError(pattern);
  if (error !== null) throw new TypeError(error);
  const segments = pattern.split("/");
  let source = "^";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".+" : "(?:[^/]+/)*";
      return;
    }
    source += segmentSource(segment);
    if (!last) source += "/";
  });
  source += "$";
  const re = new RegExp(source, "is");
  const exactRe = new RegExp(source, "s");
  return Object.freeze({
    pattern,
    test: (path: string) => re.test(path),
    exact: (path: string) => exactRe.test(path),
  });
}

/** True when any of `globs` matches `path`. */
export function matchesAny(globs: readonly Glob[], path: string): boolean {
  for (const glob of globs) if (glob.test(path)) return true;
  return false;
}
