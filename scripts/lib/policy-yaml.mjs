// A strict reader for pnpm-workspace.yaml. The policy file is kept to a small subset of YAML so
// that what this reader sees is exactly what pnpm sees: top-level keys with a plain scalar, `{}`
// or `[]`, a block list of scalars, or a block map of scalar values one level deep, each line with
// an optional trailing `# comment`. Anything else (anchors, aliases, tags, flow collections with
// content, multi-line scalars, several documents, deeper nesting, tabs) is refused, because a
// construct this reader skipped could change pnpm's settings without the check noticing.

/**
 * @typedef {string | number | boolean | null} Scalar
 * @typedef {{ value: Scalar, line: number, comment?: string, above?: string[] }} Item
 * @typedef {{ kind: "scalar", value: Scalar, line: number, comment?: string }
 *   | { kind: "list", items: Item[], line: number, comment?: string }
 *   | { kind: "map", entries: Map<string, Item>, line: number, comment?: string }} Node
 * @typedef {{ keys: Map<string, Node>, errors: { line: number, message: string }[] }} Policy
 */

/**
 * Splits a line into its content and trailing comment. A `#` starts a comment only at the start
 * of the content or after whitespace, and never inside quotes.
 * @param {string} text
 * @returns {{ content: string, comment?: string }}
 */
function splitComment(text) {
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "#" && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
      return { content: text.slice(0, i).trimEnd(), comment: text.slice(i).trim() };
    }
  }
  return { content: text.trimEnd() };
}

/**
 * Parses a scalar the way YAML 1.2's core schema would for the forms the policy uses.
 * @param {string} text
 * @returns {Scalar | undefined} undefined when the form is outside the subset
 */
export function parseScalar(text) {
  if (/^'([^']|'')*'$/.test(text)) return text.slice(1, -1).replaceAll("''", "'");
  if (/^"[^"\\]*"$/.test(text)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?(0|[1-9][0-9]*)$/.test(text)) return Number(text);
  // Plain scalars: refuse indicators that would mean something else to a full YAML parser.
  if (
    text === "" ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /: |\s#/.test(text) ||
    text.endsWith(":")
  ) {
    return undefined;
  }
  return text;
}

/**
 * Parses a key (a plain or quoted scalar used as a map key).
 * @param {string} text
 * @returns {string | undefined}
 */
function parseKey(text) {
  const value = parseScalar(text);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Finds the `key: value` split outside quotes.
 * @param {string} content
 * @returns {{ key: string, rest: string } | undefined}
 */
function splitKey(content) {
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const char = content.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === ":" && (i === content.length - 1 || content.charAt(i + 1) === " ")) {
      return { key: content.slice(0, i), rest: content.slice(i + 1).trim() };
    }
  }
  return undefined;
}

/**
 * Parses the policy file.
 * @param {string} text
 * @returns {Policy}
 */
export function parsePolicy(text) {
  /** @type {Map<string, Node>} */
  const keys = new Map();
  /** @type {{ line: number, message: string }[]} */
  const errors = [];
  const lines = text.split("\n");
  /** @type {Node | null} */
  let open = null; // the top-level block list or map being filled
  /** @type {string[]} */
  let pendingComments = []; // whole-line comments just above the next item
  /** @type {number | null} */
  let childIndent = null;

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.includes("\t")) {
      errors.push({ line, message: "tabs are not allowed" });
      continue;
    }
    if (/^(---|\.\.\.)(\s|$)/.test(raw) || raw.startsWith("%")) {
      errors.push({ line, message: "one document only, with no directives" });
      continue;
    }
    const { content, comment } = splitComment(raw);
    if (content.trim() === "") {
      if (comment !== undefined && raw.trimStart().startsWith("#")) pendingComments.push(comment);
      else pendingComments = [];
      continue;
    }
    const indent = content.length - content.trimStart().length;
    const body = content.trim();
    if (/(^|[\s[{,])[&*!][^\s]/.test(body) || /[|>][-+]?$/.test(body)) {
      errors.push({ line, message: "anchors, aliases, tags and block scalars are not allowed" });
      continue;
    }

    if (indent === 0) {
      open = null;
      childIndent = null;
      pendingComments = [];
      const split = splitKey(body);
      const key = split ? parseKey(split.key) : undefined;
      if (split === undefined || key === undefined) {
        errors.push({ line, message: "expected a top-level `key: value`" });
        continue;
      }
      if (keys.has(key)) {
        errors.push({ line, message: `the key ${key} appears twice` });
        continue;
      }
      /** @type {Node} */
      let node;
      if (split.rest === "") {
        node = { kind: "map", entries: new Map(), line }; // becomes a list if items follow
        open = node;
      } else if (split.rest === "{}") {
        node = { kind: "map", entries: new Map(), line };
      } else if (split.rest === "[]") {
        node = { kind: "list", items: [], line };
      } else {
        const value = parseScalar(split.rest);
        if (value === undefined) {
          // Keep the key, so the checks still see that it is present.
          errors.push({ line, message: `the value of ${key} is outside the supported subset` });
        }
        node = { kind: "scalar", value: value ?? null, line };
      }
      if (comment !== undefined) node.comment = comment;
      keys.set(key, node);
      continue;
    }

    if (open === null) {
      errors.push({ line, message: "an indented line must belong to a top-level list or map" });
      continue;
    }
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) {
      errors.push({ line, message: "only one level of nesting, with one indentation, is allowed" });
      continue;
    }
    /** @type {Item} */
    const item = { value: null, line };
    if (comment !== undefined) item.comment = comment;
    if (pendingComments.length > 0) item.above = pendingComments;
    pendingComments = [];

    if (body.startsWith("- ") || body === "-") {
      if (open.kind === "map" && open.entries.size === 0) {
        const list = /** @type {Node} */ ({ kind: "list", items: [], line: open.line });
        if (open.comment !== undefined) list.comment = open.comment;
        for (const [k, v] of keys) if (v === open) keys.set(k, list);
        open = list;
      }
      const value = parseScalar(body.slice(2).trim());
      if (open.kind !== "list" || value === undefined) {
        errors.push({ line, message: "a list item must be a scalar in a list" });
        continue;
      }
      item.value = value;
      open.items.push(item);
      continue;
    }
    if (open.kind !== "map") {
      errors.push({ line, message: "a list cannot also hold `key: value` lines" });
      continue;
    }
    const split = splitKey(body);
    const key = split ? parseKey(split.key) : undefined;
    const value = split ? parseScalar(split.rest) : undefined;
    if (split === undefined || key === undefined || value === undefined) {
      errors.push({ line, message: "a map entry must be `key: scalar`" });
      continue;
    }
    if (open.entries.has(key)) {
      errors.push({ line, message: `the key ${key} appears twice` });
      continue;
    }
    item.value = value;
    open.entries.set(key, item);
  }
  return { keys, errors };
}
