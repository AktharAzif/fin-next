// A `_headers` parser and matcher that follow Cloudflare's rules for Workers static assets (spec
// 01 §7.4: the static host reads the same rendered file the deploy uploads):
//
//   - a line whose trimmed text starts with `/` or `https://` opens a rule for that URL pattern;
//     every other non-blank line belongs to the rule above it;
//   - `Name: value` adds a header (names are case-insensitive and may not hold spaces; a name
//     given twice in one rule is joined with ", ");
//   - `! Name` detaches a header that an earlier matching rule set;
//   - `#` starts a comment line; at most 100 rules and 2,000 characters a line;
//   - `*` (once per pattern) matches anything, slashes included, and is `:splat` in values;
//     `:name` matches one path segment (or one host label) and is `:name` in values;
//   - every matching rule applies, in file order: its detaches first, then its headers, each of
//     which replaces the answer's own value the first time a rule names it and joins the earlier
//     rules' value (", ") after that.
//
// A file that breaks a rule is refused as a whole (Cloudflare skips the bad line and warns at
// upload; a test harness should not hide the mistake).

export const MAX_RULES = 100;
export const MAX_LINE_LENGTH = 2000;

export interface HeaderRule {
  /** The pattern as written: a path, or `https://host/path`. */
  readonly pattern: string;
  /** 1-based line of the pattern. */
  readonly line: number;
  /** Headers this rule sets, names lower-cased, in first-seen order. */
  readonly set: ReadonlyArray<readonly [name: string, value: string]>;
  /** Header names this rule detaches, lower-cased. */
  readonly unset: readonly string[];
}

export interface HeadersIssue {
  readonly line: number;
  readonly message: string;
}

export interface ParsedHeaders {
  readonly rules: readonly HeaderRule[];
  readonly issues: readonly HeadersIssue[];
}

const PATTERN_LINE = /^(?:https:\/\/|\/)/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface Draft {
  pattern: string;
  line: number;
  set: Map<string, string>;
  unset: string[];
}

function validatePattern(pattern: string): string | undefined {
  if (/\s/.test(pattern)) return "a URL pattern holds no whitespace";
  if ((pattern.match(/\*/g) ?? []).length > 1) return "a URL pattern holds at most one *";
  if (pattern.startsWith("https://")) {
    const rest = pattern.slice("https://".length);
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    if (host === "") return "an absolute URL pattern names a host";
    if (/:\d+$/.test(host)) return "an absolute URL pattern names no port";
  } else if (pattern.startsWith("//")) {
    return "a path pattern starts with exactly one /";
  }
  return undefined;
}

/** Parses a `_headers` file. Never throws; every problem is an issue with its line. */
export function parseHeaders(text: string): ParsedHeaders {
  const rules: HeaderRule[] = [];
  const issues: HeadersIssue[] = [];
  let draft: Draft | undefined;
  let skipping = false;
  const close = () => {
    if (draft === undefined) return;
    if (draft.set.size === 0 && draft.unset.length === 0) {
      issues.push({ line: draft.line, message: "a rule sets or detaches at least one header" });
    } else if (rules.length >= MAX_RULES) {
      issues.push({ line: draft.line, message: `a file holds at most ${MAX_RULES} rules` });
    } else {
      rules.push({
        pattern: draft.pattern,
        line: draft.line,
        set: [...draft.set.entries()],
        unset: draft.unset,
      });
    }
    draft = undefined;
  };
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.length > MAX_LINE_LENGTH) {
      issues.push({
        line: lineNumber,
        message: `a line holds at most ${MAX_LINE_LENGTH} characters`,
      });
      continue;
    }
    if (PATTERN_LINE.test(line)) {
      close();
      const problem = validatePattern(line);
      if (problem !== undefined) {
        issues.push({ line: lineNumber, message: problem });
        skipping = true;
        continue;
      }
      skipping = false;
      draft = { pattern: line, line: lineNumber, set: new Map(), unset: [] };
      continue;
    }
    if (draft === undefined) {
      if (!skipping) {
        issues.push({ line: lineNumber, message: "a header comes after a URL pattern" });
      }
      continue;
    }
    if (line.startsWith("!")) {
      const name = line.slice(1).trim().toLowerCase();
      if (!HEADER_NAME.test(name)) {
        issues.push({ line: lineNumber, message: "a detach line is `! Header-Name`" });
      } else {
        draft.unset.push(name);
      }
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      issues.push({ line: lineNumber, message: "a header line is `Name: value`" });
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "" || !HEADER_NAME.test(name)) {
      issues.push({ line: lineNumber, message: "a header name is one token with no spaces" });
      continue;
    }
    if (value === "") {
      issues.push({ line: lineNumber, message: "a header has a value" });
      continue;
    }
    const earlier = draft.set.get(name);
    draft.set.set(name, earlier === undefined ? value : `${earlier}, ${value}`);
  }
  close();
  return { rules, issues };
}

/** Parses a file and throws, listing every issue, unless it is clean. */
export function parseHeadersStrict(text: string, source = "_headers"): readonly HeaderRule[] {
  const { rules, issues } = parseHeaders(text);
  if (issues.length > 0) {
    const list = issues.map((issue) => `${source}:${issue.line}: ${issue.message}`).join("\n");
    throw new Error(`the headers file is not valid:\n${list}`);
  }
  return rules;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

interface CompiledRule {
  readonly rule: HeaderRule;
  readonly absolute: boolean;
  readonly regExp: RegExp;
  readonly names: readonly string[];
}

function compile(rule: HeaderRule): CompiledRule {
  const absolute = rule.pattern.startsWith("https://");
  const hostEnd = absolute ? rule.pattern.indexOf("/", "https://".length) : 0;
  const names: string[] = [];
  let source = "";
  const pattern = rule.pattern;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] as string;
    if (char === "*") {
      source += "(?<splat>.*)";
      names.push("splat");
      i += 1;
      continue;
    }
    const placeholder = /^:([A-Za-z]\w*)/.exec(pattern.slice(i));
    if (char === ":" && placeholder !== null && !(absolute && i < "https://".length)) {
      const name = placeholder[1] as string;
      const inHost = absolute && (hostEnd === -1 || i < hostEnd);
      source += inHost ? `(?<${name}>[^/.]+)` : `(?<${name}>[^/]+)`;
      names.push(name);
      i += placeholder[0].length;
      continue;
    }
    source += escapeRegExp(char);
    i += 1;
  }
  return { rule, absolute, regExp: new RegExp(`^${source}$`), names };
}

export interface MatchedRule {
  readonly rule: HeaderRule;
  /** The rule's headers with `:splat` and `:name` filled in from the match. */
  readonly set: ReadonlyArray<readonly [name: string, value: string]>;
  readonly unset: readonly string[];
}

export interface HeadersMatcher {
  /** The rules that apply to a request, in file order. */
  match(hostname: string, pathname: string): MatchedRule[];
}

/** Compiles rules into a matcher. Throws when a placeholder is used twice in one pattern. */
export function compileHeaders(rules: readonly HeaderRule[]): HeadersMatcher {
  const compiled = rules.map((rule) => {
    try {
      return compile(rule);
    } catch {
      throw new Error(`_headers:${rule.line}: the URL pattern cannot be compiled`);
    }
  });
  return {
    match(hostname, pathname) {
      const matched: MatchedRule[] = [];
      for (const { rule, absolute, regExp, names } of compiled) {
        const result = regExp.exec(absolute ? `https://${hostname}${pathname}` : pathname);
        if (result === null) continue;
        const groups = result.groups ?? {};
        const fill = (value: string) =>
          names.reduce((text, name) => text.replaceAll(`:${name}`, groups[name] ?? ""), value);
        matched.push({
          rule,
          set: rule.set.map(([name, value]) => [name, fill(value)] as const),
          unset: rule.unset,
        });
      }
      return matched;
    },
  };
}

/**
 * Applies matched rules to an answer's headers, as Cloudflare does: for each rule in order, its
 * detaches delete the header, then each of its headers replaces the answer's value if no earlier
 * rule set that name, and is appended (joined with ", ") if one did.
 */
export function applyHeaderRules(headers: Headers, matched: readonly MatchedRule[]): void {
  const setByRules = new Set<string>();
  for (const { set, unset } of matched) {
    for (const name of unset) headers.delete(name);
    for (const [name, value] of set) {
      if (setByRules.has(name)) {
        headers.append(name, value);
      } else {
        headers.set(name, value);
        setByRules.add(name);
      }
    }
  }
}
