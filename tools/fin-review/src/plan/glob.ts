// Path globs for tools/layout.json tiers, control paths and the CI path classes.
//
// `**` as a whole segment matches any number of directories (and, at the end, anything below);
// `*` matches within one segment; `?` one character of a segment. Nothing else is special, and a
// pattern with any other punctuation is refused rather than guessed at. Matching ignores case
// (spec 07 §2.4: one build machine's file system does) and treats a newline in a path as an
// ordinary character.

const GLOB_CHARS_RE = /^[A-Za-z0-9_.@+\-*?/]+$/;

export interface Glob {
  readonly pattern: string;
  readonly test: (path: string) => boolean;
}

/** Why `pattern` is not a glob this module accepts, or null when it is. */
export function globError(pattern: unknown): string | null {
  if (typeof pattern !== "string" || pattern === "") return "a glob must be a non-empty string";
  if (!GLOB_CHARS_RE.test(pattern)) return `glob ${JSON.stringify(pattern)} uses a character other than letters, digits, _ . @ + - * ? and /`;
  const segments = pattern.split("/");
  for (const segment of segments) {
    if (segment === "") return `glob ${JSON.stringify(pattern)} has an empty segment`;
    if (segment === "." || segment === "..") return `glob ${JSON.stringify(pattern)} has a . or .. segment`;
    if (segment.includes("**") && segment !== "**") return `glob ${JSON.stringify(pattern)} uses ** inside a segment`;
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
  return Object.freeze({ pattern, test: (path: string) => re.test(path) });
}

/** True when any of `globs` matches `path`. */
export function matchesAny(globs: readonly Glob[], path: string): boolean {
  for (const glob of globs) if (glob.test(path)) return true;
  return false;
}
