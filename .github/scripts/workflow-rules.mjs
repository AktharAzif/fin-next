#!/usr/bin/env node
// workflow-rules (spec 07 §10.8; spec 01 §5.1; ARCHITECTURE §11.2, §11.5; EXECUTION §2.3). A
// control path, run by ci.yml's static job beside zizmor and actionlint. It reads every workflow
// in .github/workflows and every action (action.yml or action.yaml) anywhere under .github/, and
// refuses:
//   - the triggers pull_request_target, issue_comment, pull_request_review,
//     pull_request_review_comment and workflow_run (no comment or review trigger, ever), however
//     `on:` is written;
//   - `${{ }}` inside a run: or shell: value (values reach a shell through env: only);
//   - a reference to text strangers write (CI-15): github.event.pull_request.title, .body,
//     .head.ref, .head.label, .head.repo.default_branch, github.head_ref, github.event.comment,
//     .review, .issue, .pages, .commits, .head_commit's message and author, a whole object that
//     holds any of them (toJSON(github.event)) or a wildcard over github; matched as GitHub reads
//     an expression: property names in any case, `['name']` as `.name`, spaces around a dot;
//   - `secrets: inherit`;
//   - a workflow without a top-level `permissions: {}`, `concurrency:` or
//     `TURBO_TELEMETRY_DISABLED: "1"` in its top-level env;
//   - a job without `timeout-minutes`, without its own `permissions`, or on a runner other than
//     ubuntu-24.04; a job that calls a reusable workflow;
//   - in a workflow with a `gate` job: a job that can fail (no `continue-on-error: true`) left out
//     of gate's needs, and a gate without `if: always()` (spec 01 §5.3: gate needs every job
//     but the non-blocking canary); a job that needs gate itself (ci.yml's `merge`) runs after
//     it and cannot be in its needs, so it is refused unless its condition is exactly
//     `github.event_name == 'push' && github.ref == 'refs/heads/main'`: no pull request waits on
//     it, and no status function (always(), !cancelled()) runs it when gate did not succeed;
//   - a checkout without `persist-credentials: false`; a setup-node without
//     `package-manager-cache: false`, or with `cache:`;
//   - a `uses:` that is not a GitHub-owned action (actions/*, github/*) or a local action under
//     .github/, or is not pinned to a 40-character commit SHA with its version in a comment; a
//     docker:// action, and a local action that runs a container;
//   - a container or service image not pinned by digest;
//   - a cache in release.yml, dependencies.yml or nightly.yml (release builds and scans restore no
//     cache, ARCHITECTURE §11.3); in a workflow a pull request can start, a cache saved other than
//     on push (an actions/cache/save whose `if:` is not `github.event_name == 'push' && ...`, or
//     actions/cache, which saves in its post step), and a cache of the review ledger;
//   - and every YAML form the reader below does not read, so no rule is ever skipped by a file it
//     misreads: a line break other than LF or CRLF (a CR alone, NEL, LS or PS, which YAML reads
//     as one); a control, format or space character other than space and tab, anywhere (YAML's
//     white space is space and tab only); a backslash escape in a double-quoted scalar, key or
//     value (YAML decodes `\x75`, the rules would compare it undecoded); a tab in the
//     indentation, a sequence item no deeper than its key, a flow collection that does not close
//     on its line or that it cannot read, a value continued on the next line other than as a
//     block scalar (| or >), a block scalar with an indentation indicator or anywhere but a run:,
//     options:, description:, with: or env: value (elsewhere a rule may compare the value), an
//     explicit key (`? `), an anchor, alias, tag or merge key, a key given twice in one mapping,
//     and more than one document;
// and, across files, a Postgres image in a workflow that differs from compose.yaml's.
//
// The reader outlines YAML's block style and reads a flow collection that closes on its own line
// ({ ... } or [ ... ]) into the same outline, so every rule reads both styles alike. It is not a
// full YAML parser: what it does not read, it refuses (the last item above) rather than skip.
// actionlint and zizmor run beside it, but no rule here relies on them.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { clean, isMain, say } from "./lib/ci.mjs";

/** @typedef {{ file: string, line: number, rule: string, message: string }} Finding */
/**
 * @typedef {{
 *   key: string | null, value: string, raw: string, line: number, indent: number,
 *   item: boolean, inline: boolean, flow: boolean, children: OutlineNode[],
 *   scalar: { line: number, text: string }[],
 * }} OutlineNode
 */

export const FORBIDDEN_TRIGGERS = [
  "pull_request_target",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_run",
];
/** Strangers' text (GitHub's list of untrusted inputs), matched in expressionText's form. */
export const UNTRUSTED_CONTEXTS = [
  /github\.event\.pull_request\.title/,
  /github\.event\.pull_request\.body/,
  /github\.event\.pull_request\.head\.ref/,
  /github\.event\.pull_request\.head\.label/,
  /github\.event\.pull_request\.head\.repo\.default_branch/,
  /github\.head_ref/,
  /github\.event\.comment/,
  /github\.event\.review/,
  /github\.event\.issue/,
  /github\.event\.pages/,
  /github\.event\.commits/,
  /github\.event\.head_commit\.(?:message|author)/,
  // A whole object that holds any of the above, read at once (toJSON, format, a comparison).
  /\bgithub\.event(?:\.pull_request(?:\.head(?:\.repo)?)?|\.head_commit(?:\.author)?)?(?![\w.-])/,
  /\btojson\(\s*github\s*\)/,
  // A wildcard over the github context reads every field below it.
  /\bgithub(?:\.[\w-]+)*\.\*/,
];
export const RUNNER = "ubuntu-24.04";
/** The opening of a GitHub expression, spelled so that no linter reads it as a template. */
export const EXPRESSION_OPEN = `${"$"}{{`;
export const ACTION_OWNERS = new Set(["actions", "github"]);
/** Workflows that restore no cache (release builds and scans, ARCHITECTURE §11.3). */
export const NO_CACHE_WORKFLOWS = new Set(["release.yml", "dependencies.yml", "nightly.yml"]);
/** Keys whose value a runner hands to a shell as a command. */
const COMMAND_KEYS = new Set(["run", "shell"]);

// White space is a space or a tab, as YAML's is (JavaScript's \s holds many more, refused below).
const KEY = /^("[^"]*"|'[^']*'|[^ \t"'#:{}[\],&*!|>%@`][^:#]*?)[ \t]*:(?=[ \t]|$)/;
const PINNED = /^([\w.-]+)\/([\w.-]+)(\/[\w./-]+)?@([0-9a-f]{40})$/;
/** A block scalar's header in any form YAML takes, and the form the reader reads. */
const BLOCK_SCALAR = /^[|>][1-9+-]*$/;
const READ_BLOCK_SCALAR = /^[|>][+-]?$/;
/**
 * Where a block scalar may stand: as the value of these keys, or of any key under `with:` or
 * `env:`. No rule reads these as one scalar (a command's lines, a container's options, an
 * action's description, inputs and settings, each read line by line or compared and refused when
 * not equal); everywhere else a rule may compare the value, which the outline keeps as `|` or `>`.
 */
const BLOCK_SCALAR_KEYS = new Set(["run", "options", "description"]);
const BLOCK_SCALAR_PARENTS = new Set(["with", "env"]);
/** Line breaks YAML reads and a line split on LF does not: CR without LF, NEL, LS and PS. */
const LINE_BREAK = /\r(?!\n)|[\u0085\u{2028}\u{2029}]/gu;
/**
 * Characters YAML and the reader would read apart: controls (but tab, LF and CRLF's CR), format
 * characters (the byte-order mark, zero-width and bidirectional controls), every space but U+0020
 * (YAML's white space is space and tab; JavaScript's trims and \s take the rest too), and U+FFFD,
 * which stands for bytes that are not UTF-8. The line breaks above have their own finding.
 */
const ODD_CHARACTER = /(?![\t\n\r\u0085\u{2028}\u{2029} ])[\p{Cc}\p{Cf}\p{Z}\u{FFFD}]/gu;
/** An anchor, an alias or a tag where a value or an entry starts. */
const ALIAS_START = /^[&*!]/;
/** A save that runs on push only: `github.event_name == 'push'`, alone or first in a conjunction. */
const PUSH_ONLY = /^github\.event_name\s*==\s*'push'\s*(?:&&[^|]*)?$/;
/** The one condition a job after the gate runs on: a push to main, with the implied success(). */
export const AFTER_GATE_IF = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

/**
 * Reads a line as YAML does for two things: where its comment starts (a `#` at the start or after
 * a space or tab, outside quotes), and whether a double-quoted scalar on it holds a backslash
 * escape (`\x75`, `\u{75}`, `\"` and the rest), which YAML decodes and the rules would compare
 * undecoded, so it is refused. A quote opens a scalar only where YAML starts a node: at the
 * line's start, after `- `, `? ` or `: ` (the indicator, then a space or tab), after `[`, `{` or
 * `,` in a flow collection, after a node's anchor or tag, and after the `:` that follows a quoted
 * scalar or a flow collection. Inside a plain scalar (`a-'b`, `x: a "b"`) a quote is a character.
 * @param {string} line
 * @returns {{ content: string, escape: boolean }}
 */
function readLine(line) {
  let quote = "";
  let escaped = false;
  /** "start": a node may start here; "plain": inside a plain scalar; "after": after a quoted
   * scalar or a flow collection. */
  let state = "start";
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote !== "") {
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") i++;
        else {
          quote = "";
          state = "after";
        }
      } else if (c === "\\" && quote === '"') {
        escaped = true;
        i++;
      }
      continue;
    }
    if (c === " " || c === "\t") continue;
    if (c === "#" && (i === 0 || /[ \t]/.test(line[i - 1] ?? ""))) {
      return { content: line.slice(0, i), escape: escaped };
    }
    const next = line[i + 1] ?? "";
    const spaced = next === "" || next === " " || next === "\t";
    const flowEnd = depth > 0 && (c === "]" || c === "}");
    if (state === "plain") {
      if (
        (c === ":" && (spaced || (depth > 0 && ",[]{}".includes(next)))) ||
        (depth > 0 && c === ",")
      ) {
        state = "start";
      } else if (flowEnd) {
        depth--;
        state = "after";
      }
    } else if (state === "start") {
      if (c === '"' || c === "'") quote = c;
      else if ((c === "-" || c === "?" || c === ":") && spaced) {
        // An indicator: a node may follow.
      } else if (c === "&" || c === "!") {
        // An anchor or a tag, then the node itself.
        while (i + 1 < line.length && !/[ \t]/.test(line[i + 1] ?? "")) i++;
      } else if (c === "[" || c === "{") depth++;
      else if (depth > 0 && c === ",") {
        // An empty entry.
      } else if (flowEnd) {
        depth--;
        state = "after";
      } else state = "plain";
    } else if (c === ":" || (depth > 0 && c === ",")) {
      state = "start";
    } else if (flowEnd) {
      depth--;
    } else {
      state = "plain";
    }
  }
  return { content: line, escape: escaped };
}

/**
 * Whether a scalar the reader read is double-quoted and holds a backslash escape.
 * @param {string} scalar
 */
function escapedScalar(scalar) {
  return scalar.trimStart().startsWith('"') && scalar.includes("\\");
}

/**
 * The text of a line before its comment: a `#` at the start or after a space, outside quotes.
 * @param {string} line
 * @returns {string}
 */
export function stripComment(line) {
  return readLine(line).content;
}

/**
 * A scalar as YAML reads it: a single-quoted one with its `''` read as `'`, a double-quoted one
 * without its quotes (an escape in one is refused, so there is nothing to decode).
 * @param {string} key
 * @returns {string}
 */
function unquote(key) {
  const t = key.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replaceAll("''", "'");
  }
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/**
 * Whether a value that opens a quote closes it, with nothing after (a quoted scalar on one line).
 * @param {string} value
 */
function quoteCloses(value) {
  const q = value[0];
  if (q !== '"' && q !== "'") return true;
  for (let i = 1; i < value.length; i++) {
    if (q === '"' && value[i] === "\\") {
      i++;
      continue;
    }
    if (value[i] !== q) continue;
    if (q === "'" && value[i + 1] === "'") {
      i++;
      continue;
    }
    return value.slice(i + 1).trim() === "";
  }
  return false;
}

/**
 * @param {string | null} key
 * @param {string} value
 * @param {string} raw
 * @param {number} line
 * @param {number} indent
 * @param {boolean} item
 * @returns {OutlineNode}
 */
function makeNode(key, value, raw, line, indent, item) {
  return {
    key,
    value,
    raw,
    line,
    indent,
    item,
    inline: false,
    flow: false,
    children: [],
    scalar: [],
  };
}

class FlowError extends Error {
  /** @param {"unclosed" | "alias" | "syntax"} why */
  constructor(why) {
    super(why);
    this.why = why;
  }
}

/**
 * Reads a flow collection that closes on its line ({ ... } or [ ... ], its comment already
 * stripped) into outline nodes, as YAML reads it: quoted and plain scalars, nested collections,
 * `key: value` pairs (a key alone has no value), and a single-pair mapping as a sequence entry. A
 * mapping's pairs become key nodes, a sequence's entries item nodes, as the block style's would.
 * `escape` when a double-quoted scalar in it holds a backslash escape (refused, see readLine).
 * @param {string} text
 * @param {{ line: number, indent: number, raw: string }} at
 * @returns {{ ok: true, mapping: boolean, children: OutlineNode[], escape: boolean }
 *   | { ok: false, why: "unclosed" | "alias" | "syntax" }}
 */
export function parseFlow(text, at) {
  let i = 0;
  let escaped = false;
  /** @param {"unclosed" | "alias" | "syntax"} why @returns {never} */
  const fail = (why) => {
    throw new FlowError(why);
  };
  const space = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  };
  /**
   * @param {string | null} key
   * @param {string} value
   * @param {boolean} item
   */
  const node = (key, value, item) => {
    const n = makeNode(key, value, at.raw, at.line, at.indent + 1, item);
    n.flow = true;
    n.inline = true;
    return n;
  };
  /** A quoted or plain scalar, as written. */
  const scalar = () => {
    const c = text[i] ?? "";
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < text.length) {
        if (c === '"' && text[i] === "\\") {
          escaped = true;
          i += 2;
          continue;
        }
        if (text[i] === c) {
          if (c === "'" && text[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          return text.slice(start, i);
        }
        i++;
      }
      return fail("unclosed");
    }
    if (ALIAS_START.test(c)) fail("alias");
    if ("?|>%@`".includes(c) || (c === "-" && /[ \t]/.test(text[i + 1] ?? " "))) fail("syntax");
    const start = i;
    while (i < text.length) {
      const d = text[i] ?? "";
      if (",[]{}".includes(d)) break;
      if (d === ":" && (i + 1 === text.length || /[ \t,[\]{}]/.test(text[i + 1] ?? ""))) break;
      i++;
    }
    return text.slice(start, i).trimEnd();
  };
  /** @returns {{ text: string, children: OutlineNode[] }} */
  const value = () => {
    space();
    const c = text[i] ?? "";
    if (i >= text.length || ",}]".includes(c)) return { text: "", children: [] };
    if (c === "{" || c === "[") {
      const start = i;
      const children = collection();
      return { text: text.slice(start, i), children };
    }
    return { text: scalar(), children: [] };
  };
  /** @returns {OutlineNode} */
  const pair = () => {
    if (text[i] === "{" || text[i] === "[") fail("syntax");
    const key = scalar();
    if (key === "") fail("syntax");
    space();
    const n = node(unquote(key), "", false);
    if (text[i] === ":") {
      i++;
      const v = value();
      n.value = v.text;
      n.children = v.children;
    }
    return n;
  };
  /** @returns {OutlineNode} */
  const entry = () => {
    const item = node(null, "", true);
    if (text[i] === "{" || text[i] === "[") {
      const start = i;
      const children = collection();
      if (text[start] === "{") item.children = children;
      else {
        const inner = node(null, text.slice(start, i), false);
        inner.children = children;
        item.children = [inner];
      }
      return item;
    }
    const s = scalar();
    space();
    if (text[i] === ":") {
      i++;
      const v = value();
      const n = node(unquote(s), v.text, false);
      n.children = v.children;
      item.children = [n];
    } else {
      item.children = [node(null, s, false)];
    }
    return item;
  };
  /** @returns {OutlineNode[]} */
  const collection = () => {
    const mapping = text[i] === "{";
    const close = mapping ? "}" : "]";
    i++;
    /** @type {OutlineNode[]} */
    const children = [];
    for (;;) {
      space();
      if (i >= text.length) fail("unclosed");
      if (text[i] === close) {
        i++;
        return children;
      }
      children.push(mapping ? pair() : entry());
      space();
      if (i >= text.length) fail("unclosed");
      if (text[i] === ",") i++;
      else if (text[i] !== close) fail("syntax");
    }
  };
  try {
    space();
    const mapping = text[i] === "{";
    if (!mapping && text[i] !== "[") return { ok: false, why: "syntax" };
    const children = collection();
    space();
    if (i < text.length) return { ok: false, why: "syntax" };
    return { ok: true, mapping, children, escape: escaped };
  } catch (error) {
    if (error instanceof FlowError) return { ok: false, why: error.why };
    throw error;
  }
}

/**
 * Reads the outline of a YAML file: block mappings and sequences, inline values, block scalars
 * (kept as lines) and flow collections that close on their line (read into child nodes). Every
 * form it does not read is returned as a finding (see the header).
 * @param {string} file
 * @param {string} text
 * @returns {{ root: OutlineNode, findings: Finding[] }}
 */
export function parseOutline(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file, line, rule, message });
  const multiLine = (/** @type {number} */ line) =>
    add(
      line,
      "multi-line-value",
      "continue a value on the next line only as a block scalar (| or >); write it on its key's line",
    );
  const root = makeNode(null, "", "", 0, -1, false);
  /** @type {OutlineNode[]} */
  const stack = [root];
  const top = () => /** @type {OutlineNode} */ (stack.at(-1));
  /** @type {{ node: OutlineNode, parentIndent: number } | null} */
  let block = null;
  let content = false;
  /** @type {Set<number>} */
  const escapeLines = new Set();
  /**
   * Refuses a backslash escape in a double-quoted scalar, once a line: found by the line's own
   * reading (readLine) or in a scalar the reader read (a key, a value, an item, a flow entry).
   * @param {number} line
   */
  const refuseEscape = (line) => {
    if (escapeLines.has(line)) return;
    escapeLines.add(line);
    add(
      line,
      "yaml-escape",
      "no backslash escape in a double-quoted scalar: YAML decodes it, the rules would not",
    );
  };
  /**
   * Reads a flow collection, or refuses it (null).
   * @param {string} flowText
   * @param {{ line: number, indent: number, raw: string }} at
   */
  const readFlow = (flowText, at) => {
    const parsed = parseFlow(flowText, at);
    if (parsed.ok) {
      if (parsed.escape) refuseEscape(at.line);
      return parsed;
    }
    if (parsed.why === "alias") {
      add(at.line, "yaml-alias", "no anchor, alias or tag: the reader does not follow them");
    } else if (parsed.why === "unclosed") {
      add(at.line, "flow-collection", "close a flow collection on the line that opens it");
    } else {
      add(at.line, "flow-collection", "write this flow collection in block style");
    }
    return null;
  };
  /** The line an index of the text is on. */
  const lineAt = (/** @type {number} */ index) => text.slice(0, index).split("\n").length;
  // Characters that make YAML and this reader see different lines or different text, anywhere
  // in the file (a line break inside a block scalar ends it just the same).
  for (const m of text.matchAll(LINE_BREAK)) {
    add(
      lineAt(m.index ?? 0),
      "line-break",
      "a line break YAML reads and this reader does not (CR without LF, NEL, LS or PS): end lines with LF",
    );
  }
  for (const m of text.matchAll(ODD_CHARACTER)) {
    const code = (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    add(
      lineAt(m.index ?? 0),
      "character",
      `the character U+${code}: no control, format or space character but space and tab`,
    );
  }
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const lead = /^[ \t]*/.exec(raw)?.[0] ?? "";
    if (block !== null) {
      if (raw.trim() === "" || lead.length > block.parentIndent) {
        block.node.scalar.push({ line, text: raw.trim() });
        continue;
      }
      block = null;
    }
    if (lead.includes("\t")) {
      add(line, "indentation", "a tab in the indentation");
    }
    const { content: stripped, escape: lineEscape } = readLine(raw);
    if (lineEscape) refuseEscape(line);
    if (stripped.trim() === "") continue;
    let col = lead.length;
    let rest = stripped.slice(col).trimEnd();
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(rest) || rest.startsWith("%")) {
      if (content || rest !== "---") {
        add(line, "yaml-document", "one YAML document per file, with no directive or end marker");
      }
      continue;
    }
    content = true;
    /** @type {OutlineNode | null} */
    let fresh = null;
    while (rest === "-" || rest.startsWith("- ")) {
      const parent = top();
      if (parent.key !== null && !parent.item && parent.value === "" && parent.indent >= col) {
        add(line, "indentation", "indent a sequence item deeper than its key");
      }
      while (top().indent >= col) stack.pop();
      if (top().inline) multiLine(line);
      const item = makeNode(null, "", raw, line, col, true);
      top().children.push(item);
      stack.push(item);
      fresh = item;
      const after = rest === "-" ? "" : rest.slice(2);
      col += 2 + (after.length - after.trimStart().length);
      rest = after.trimStart();
    }
    if (rest === "") continue;
    // A double-quoted key, item or scalar first on the line, as the reader reads it.
    if (escapedScalar(rest)) refuseEscape(line);
    while (top().indent >= col) stack.pop();
    const parent = top();
    if (/^[?:](?:\s|$)/.test(rest)) {
      add(line, "explicit-key", "no explicit key (`? ` or `: `): write `key: value`");
    }
    if (ALIAS_START.test(rest)) {
      add(line, "yaml-alias", "no anchor, alias or tag: the reader does not follow them");
    }
    if (parent.inline) multiLine(line);
    const match = KEY.exec(rest);
    if (match !== null) {
      const value = rest.slice(match[0].length).trim();
      if (escapedScalar(value)) refuseEscape(line);
      const node = makeNode(unquote(match[1] ?? ""), value, raw, line, col, false);
      parent.children.push(node);
      stack.push(node);
      if (node.key === "<<") {
        add(line, "yaml-alias", "no merge key (<<): the reader does not follow it");
      }
      if (ALIAS_START.test(value)) {
        add(line, "yaml-alias", "no anchor, alias or tag: the reader does not follow them");
      } else if (BLOCK_SCALAR.test(value)) {
        block = { node, parentIndent: col };
        const where =
          BLOCK_SCALAR_KEYS.has(node.key ?? "") || BLOCK_SCALAR_PARENTS.has(parent.key ?? "");
        if (!READ_BLOCK_SCALAR.test(value)) {
          add(line, "block-scalar", "no indentation indicator on a block scalar (| or > alone)");
        } else if (!where) {
          add(
            line,
            "block-scalar",
            `a block scalar only as run:, options:, description: or a with: or env: value; write ${clean(node.key ?? "", 60)}'s value on its line`,
          );
        }
      } else if (value !== "") {
        node.inline = true;
        if (/^[[{]/.test(value)) {
          const parsed = readFlow(value, { line, indent: col, raw });
          if (parsed !== null) {
            node.flow = true;
            node.children.push(...parsed.children);
          }
        } else if (!quoteCloses(value)) {
          multiLine(line);
        }
      }
    } else if (parent === fresh && fresh.children.length === 0) {
      // The scalar or flow collection of the sequence item this line opened: a flow mapping's
      // pairs become the item's own, as `- key: value` lines would.
      fresh.inline = true;
      const holder = makeNode(null, rest, raw, line, col, false);
      holder.inline = true;
      if (/^[[{]/.test(rest)) {
        const parsed = readFlow(rest, { line, indent: col, raw });
        if (parsed?.mapping) {
          fresh.flow = true;
          fresh.children.push(...parsed.children);
        } else {
          holder.flow = parsed !== null;
          holder.children.push(...(parsed?.children ?? []));
          fresh.children.push(holder);
        }
      } else {
        fresh.children.push(holder);
        if (!quoteCloses(rest)) multiLine(line);
      }
    } else {
      // A scalar or a flow collection on a line of its own: a value continued from the line
      // before, or started below its key; YAML may read either, the outline reads neither.
      multiLine(line);
      const node = makeNode(null, rest, raw, line, col, false);
      node.inline = true;
      parent.children.push(node);
    }
  }
  for (const node of [root, ...walk(root)]) {
    /** @type {Set<string>} */
    const seen = new Set();
    for (const c of node.children) {
      if (c.key === null) continue;
      if (seen.has(c.key)) {
        add(c.line, "duplicate-key", `the key ${clean(c.key, 60)} is given twice in one mapping`);
      }
      seen.add(c.key);
    }
  }
  return { root, findings };
}

/**
 * @param {OutlineNode} node
 * @param {string} key
 * @returns {OutlineNode | undefined}
 */
export function child(node, key) {
  return node.children.find((c) => c.key === key);
}

/**
 * Every node of the outline, depth first.
 * @param {OutlineNode} node
 * @returns {Generator<OutlineNode>}
 */
function* walk(node) {
  for (const c of node.children) {
    yield c;
    yield* walk(c);
  }
}

/**
 * Whether a mapping sets `key` to `value`.
 * @param {OutlineNode | undefined} node
 * @param {string} key
 * @param {string} value
 */
function sets(node, key, value) {
  const inner = node === undefined ? undefined : child(node, key);
  return inner !== undefined && unquote(inner.value) === value;
}

/**
 * Whether a mapping has `key` at all.
 * @param {OutlineNode | undefined} node
 * @param {string} key
 */
function has(node, key) {
  return node !== undefined && child(node, key) !== undefined;
}

/**
 * The scalars of a value written as one scalar, or as a sequence of them (block or flow).
 * @param {OutlineNode | undefined} node
 * @returns {string[]}
 */
function scalarList(node) {
  if (node === undefined) return [];
  if (node.children.length === 0) return node.value === "" ? [] : [unquote(node.value)];
  return node.children.flatMap((c) =>
    c.item ? c.children.map((s) => s.key ?? unquote(s.value)) : [c.key ?? unquote(c.value)],
  );
}

/**
 * An expression's text in the form the context rules match: a YAML quote's escapes undone,
 * `['name']` and `["name"]` read as `.name`, no space around a dot, and lower case (GitHub reads
 * property names in any case).
 * @param {string} text
 * @returns {string}
 */
export function expressionText(text) {
  return text
    .replace(/''/g, "'")
    .replace(/\\(["'])/g, "$1")
    .replace(/\s*\[\s*(["'])([^"'\]]*)\1\s*\]/g, ".$2")
    .replace(/\s*\.\s*/g, ".")
    .toLowerCase();
}

/**
 * A condition's text without the `${{ }}` that may wrap it.
 * @param {string} value
 */
function condition(value) {
  const t = unquote(value);
  const wrapped = new RegExp(`^\\${EXPRESSION_OPEN}\\s*([\\s\\S]*?)\\s*}}$`).exec(t);
  return (wrapped?.[1] ?? t).trim();
}

/**
 * The rules every file under .github/ keeps, wherever in it a value is: strangers' text,
 * `secrets: inherit`, and expressions inside a command.
 * @param {OutlineNode} root
 * @param {(line: number, rule: string, message: string) => void} add
 */
function checkTexts(root, add) {
  for (const node of walk(root)) {
    const texts = [
      { line: node.line, text: `${node.key ?? ""} ${node.value}` },
      ...node.scalar.map((s) => ({ line: s.line, text: s.text })),
    ];
    for (const { line, text: t } of texts) {
      const expression = expressionText(t);
      for (const pattern of UNTRUSTED_CONTEXTS) {
        if (pattern.test(expression)) {
          add(line, "untrusted-context", `${pattern.source} is strangers' text and never read`);
        }
      }
    }
    if (node.key === "secrets" && unquote(node.value) === "inherit") {
      add(node.line, "secrets-inherit", "`secrets: inherit` is refused");
    }
    if (node.key !== null && COMMAND_KEYS.has(node.key)) {
      const commandTexts = [{ line: node.line, text: node.value }, ...node.scalar];
      // A command continued, or started, on lines the outline holds as children (refused as a
      // shape too); a mapping under the key (defaults: run: shell:) is not a command.
      for (const c of walk(node)) {
        if (node.inline || c.key === null) {
          commandTexts.push({ line: c.line, text: `${c.key ?? ""} ${c.value}` });
        }
      }
      for (const { line, text: t } of commandTexts) {
        if (t.includes(EXPRESSION_OPEN)) {
          add(
            line,
            "expression-in-run",
            `pass values to ${node.key}: through env:, never an expression (${EXPRESSION_OPEN} }})`,
          );
        }
      }
    }
  }
}

/**
 * The trigger names under `on:`, however it is written: a name, a list of names, or a mapping.
 * @param {OutlineNode | undefined} on
 * @returns {{ name: string, line: number }[]}
 */
function triggers(on) {
  if (on === undefined) return [];
  if (on.children.length === 0) {
    return on.value === "" ? [] : [{ name: unquote(on.value), line: on.line }];
  }
  return on.children.flatMap((c) =>
    c.item
      ? c.children.map((s) => ({ name: s.key ?? unquote(s.value), line: s.line }))
      : [{ name: c.key ?? unquote(c.value), line: c.line }],
  );
}

/**
 * The same finding once (a flow collection's text is read on its key's line and on its pairs').
 * @param {Finding[]} findings
 */
function unique(findings) {
  /** @type {Set<string>} */
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.file}\u0000${f.line}\u0000${f.rule}\u0000${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Checks one workflow file.
 * @param {string} file the workflow's path (its base name decides the per-file rules)
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkWorkflow(file, text) {
  const { root, findings } = parseOutline(file, text);
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file, line, rule, message });

  // The top level.
  const permissions = child(root, "permissions");
  if (permissions === undefined || permissions.value.replace(/\s/g, "") !== "{}") {
    add(permissions?.line ?? 1, "permissions", "the workflow needs `permissions: {}` at the top");
  }
  if (child(root, "concurrency") === undefined) {
    add(1, "concurrency", "the workflow needs a top-level concurrency group");
  }
  if (!sets(child(root, "env"), "TURBO_TELEMETRY_DISABLED", "1")) {
    add(
      1,
      "turbo-telemetry",
      'the workflow needs TURBO_TELEMETRY_DISABLED: "1" in its top-level env',
    );
  }
  const on = child(root, "on") ?? child(root, "true");
  const triggerList = triggers(on);
  if (on === undefined) add(1, "triggers", "the workflow has no `on:`");
  for (const t of triggerList) {
    if (FORBIDDEN_TRIGGERS.includes(t.name)) {
      add(t.line, "triggers", `the trigger ${t.name} is never used (spec 07 §10.8)`);
    }
  }
  const pullRequests = triggerList.some((t) => t.name === "pull_request");

  // Anywhere in the file.
  checkTexts(root, add);

  // Jobs and steps.
  const jobs = child(root, "jobs");
  if (jobs === undefined) add(1, "jobs", "the workflow has no jobs");
  for (const job of jobs?.children ?? []) {
    const name = job.key ?? "?";
    if (!has(job, "timeout-minutes")) {
      add(job.line, "timeout", `the job ${name} needs timeout-minutes`);
    }
    if (!has(job, "permissions")) {
      add(job.line, "job-permissions", `the job ${name} needs its own least permissions`);
    }
    const runsOn = child(job, "runs-on");
    if (runsOn === undefined || unquote(runsOn.value) !== RUNNER) {
      add(runsOn?.line ?? job.line, "runner", `the job ${name} runs on ${RUNNER}`);
    }
    if (child(job, "uses") !== undefined) {
      add(job.line, "reusable-workflow", `the job ${name} calls a reusable workflow; none is used`);
    }
    const container = child(job, "container");
    const images = [
      ...(container === undefined ? [] : [child(container, "image") ?? container]),
      ...(child(job, "services")?.children ?? []).map(
        (service) => child(service, "image") ?? service,
      ),
    ];
    for (const image of images) {
      if (!/@sha256:[0-9a-f]{64}["']?$/.test(image.value)) {
        add(image.line, "image-digest", "pin a container or service image by its digest");
      }
    }
    for (const step of child(job, "steps")?.children ?? []) {
      findings.push(...checkStep(file, step, { pullRequests }));
    }
  }
  if (jobs !== undefined) findings.push(...checkGate(file, jobs));
  return unique(findings);
}

/**
 * The gate job, when a workflow has one: it needs every job that can fail, and runs always(). A
 * job that needs gate runs after it, so gate cannot need it; it runs on a push to main only.
 * @param {string} file
 * @param {OutlineNode} jobs
 * @returns {Finding[]}
 */
function checkGate(file, jobs) {
  const gate = child(jobs, "gate");
  if (gate === undefined) return [];
  /** @type {Finding[]} */
  const findings = [];
  const needs = scalarList(child(gate, "needs"));
  for (const job of jobs.children) {
    if (job.key === null || job === gate) continue;
    if (scalarList(child(job, "needs")).includes("gate")) {
      const when = child(job, "if");
      if (when === undefined || condition(when.value) !== AFTER_GATE_IF) {
        findings.push({
          file,
          line: when?.line ?? job.line,
          rule: "gate-needs",
          message: `${clean(job.key, 60)} needs gate, so it runs after it: only with \`if: ${AFTER_GATE_IF}\`, nothing else`,
        });
      }
      continue;
    }
    const blocking = unquote(child(job, "continue-on-error")?.value ?? "") !== "true";
    if (blocking && !needs.includes(job.key)) {
      findings.push({
        file,
        line: gate.line,
        rule: "gate-needs",
        message: `gate needs every job that can fail; ${clean(job.key, 60)} is not in its needs`,
      });
    }
  }
  const when = child(gate, "if");
  if (when === undefined || condition(when.value) !== "always()") {
    findings.push({
      file,
      line: when?.line ?? gate.line,
      rule: "gate-needs",
      message: "gate runs `if: always()`, so a skipped or cancelled job fails it",
    });
  }
  return findings;
}

/**
 * @param {string} file
 * @param {OutlineNode} step
 * @param {{ pullRequests: boolean }} context
 * @returns {Finding[]}
 */
function checkStep(file, step, context) {
  /** @type {Finding[]} */
  const findings = [];
  const uses = child(step, "uses");
  if (uses === undefined) return findings;
  const add = (/** @type {string} */ rule, /** @type {string} */ message) =>
    findings.push({ file, line: uses.line, rule, message });
  const ref = unquote(uses.value);
  const comment = uses.raw.slice(stripComment(uses.raw).length);
  if (ref.startsWith("docker://")) {
    add("action-docker", "no docker:// action; Docker runs through the docker CLI only");
    return findings;
  }
  if (ref.startsWith("./")) {
    if (!ref.startsWith("./.github/") || ref.split("/").includes("..")) {
      add("action-local", "a local action lives under .github/");
    }
    return findings;
  }
  const pinned = PINNED.exec(ref);
  if (pinned === null) {
    add("action-pin", `pin ${clean(ref, 120)} to a full 40-character commit SHA`);
    return findings;
  }
  if (!/^#\s*v\d/.test(comment)) add("action-pin", "a pinned uses: needs its version as a comment");
  const owner = pinned[1] ?? "";
  const action = `${owner}/${pinned[2] ?? ""}${pinned[3] ?? ""}`;
  if (!ACTION_OWNERS.has(owner)) {
    add("action-owner", `${clean(action, 120)} is not a GitHub-owned action`);
  }
  const withNode = child(step, "with");
  if (action === "actions/checkout" && !sets(withNode, "persist-credentials", "false")) {
    add("checkout-credentials", "a checkout needs persist-credentials: false");
  }
  if (action === "actions/setup-node") {
    if (!sets(withNode, "package-manager-cache", "false")) {
      add("setup-node-cache", "setup-node needs package-manager-cache: false");
    }
    if (has(withNode, "cache")) add("setup-node-cache", "setup-node never caches (cache:)");
  }
  if (action.startsWith("actions/cache")) {
    if (NO_CACHE_WORKFLOWS.has(basename(file))) {
      add("no-cache", `${basename(file)} restores and saves no cache (ARCHITECTURE §11.3)`);
    }
    const path = child(withNode ?? step, "path");
    const paths = [path?.value ?? "", ...(path?.scalar.map((s) => s.text) ?? [])].join("\n");
    if (context.pullRequests && paths.includes(".fin-review/ledger")) {
      add("ledger-cache", "the review ledger is never cached by a workflow a pull request starts");
    }
    if (context.pullRequests && action === "actions/cache") {
      add(
        "cache-save",
        "actions/cache saves in its post step on every run; use actions/cache/restore, and actions/cache/save on push only",
      );
    }
    const when = child(step, "if");
    if (
      context.pullRequests &&
      action === "actions/cache/save" &&
      !PUSH_ONLY.test(condition(when?.value ?? ""))
    ) {
      add(
        "cache-save",
        "a workflow a pull request starts saves a cache on push only (if: github.event_name == 'push' && ...)",
      );
    }
  }
  return findings;
}

/**
 * Checks one action's metadata file (action.yml): its steps keep the workflows' step rules, and
 * every value the rules for any file under .github/.
 * @param {string} file
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkAction(file, text) {
  const { root, findings } = parseOutline(file, text);
  /**
   * @param {number} line
   * @param {string} rule
   * @param {string} message
   */
  const add = (line, rule, message) => findings.push({ file, line, rule, message });
  checkTexts(root, add);
  const runs = child(root, "runs");
  if (runs === undefined) {
    add(1, "action", "an action needs runs:");
    return unique(findings);
  }
  const using = unquote(child(runs, "using")?.value ?? "");
  if (/^docker$/i.test(using) || has(runs, "image")) {
    add(
      runs.line,
      "action-docker",
      "a local action runs no container; Docker runs through the docker CLI only",
    );
  }
  for (const step of child(runs, "steps")?.children ?? []) {
    // An action can be called from any workflow, a pull request's included.
    findings.push(...checkStep(file, step, { pullRequests: true }));
  }
  return unique(findings);
}

/**
 * Every Postgres image in a workflow equals compose.yaml's (spec 01 §4.2: the same image and
 * digest run in development and in CI's db and e2e jobs).
 * @param {string} root
 * @param {Map<string, string>} workflows file name to text
 * @returns {Finding[]}
 */
export function checkPins(root, workflows) {
  /** @type {Finding[]} */
  const findings = [];
  const composeFile = join(root, "compose.yaml");
  if (!existsSync(composeFile)) return findings;
  const compose = /image:\s*["']?(postgres:[^\s"']+)/.exec(readFileSync(composeFile, "utf8"));
  if (compose === null) return findings;
  for (const [file, text] of workflows) {
    for (const [index, line] of text.split("\n").entries()) {
      const m = /image:\s*["']?(postgres:[^\s"']+)/.exec(stripComment(line));
      if (m !== null && m[1] !== compose[1]) {
        findings.push({
          file,
          line: index + 1,
          rule: "postgres-pin",
          message: "the Postgres image differs from compose.yaml's (move both together)",
        });
      }
    }
  }
  return findings;
}

/**
 * The files under <root>/.github the rules read: the workflows GitHub runs (directly in
 * .github/workflows) and every action's metadata file; and every link there, which is refused,
 * since a link could point the runner at a file this check never reads.
 * @param {string} root
 */
export function githubFiles(root) {
  const dir = join(root, ".github");
  /** @type {string[]} */
  const workflows = [];
  /** @type {string[]} */
  const actions = [];
  /** @type {string[]} */
  const links = [];
  /** @param {string} current */
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      const abs = join(current, name);
      const path = relative(root, abs).split(sep).join("/");
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) links.push(path);
      else if (stat.isDirectory()) visit(abs);
      else if (current === join(dir, "workflows") && /\.ya?ml$/i.test(name)) workflows.push(path);
      else if (/^action\.ya?ml$/i.test(name)) actions.push(path);
    }
  };
  if (existsSync(dir)) visit(dir);
  return { workflows, actions, links };
}

/**
 * Checks every workflow and action under <root>/.github.
 * @param {string} root
 * @returns {{ files: number, findings: Finding[] }}
 */
export function checkRepository(root) {
  const { workflows, actions, links } = githubFiles(root);
  /** @type {Finding[]} */
  const findings = links.map((file) => ({
    file,
    line: 1,
    rule: "link",
    message: "no link under .github/: a runner would follow it to a file this check never reads",
  }));
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const file of workflows) {
    const text = readFileSync(join(root, file), "utf8");
    texts.set(file, text);
    findings.push(...checkWorkflow(file, text));
  }
  for (const file of actions)
    findings.push(...checkAction(file, readFileSync(join(root, file), "utf8")));
  findings.push(...checkPins(root, texts));
  return { files: workflows.length + actions.length, findings };
}

if (isMain(import.meta)) {
  const index = process.argv.indexOf("--root");
  const root = index > 0 ? (process.argv[index + 1] ?? ".") : process.cwd();
  const { files, findings } = checkRepository(root);
  for (const f of findings) {
    say(`workflow-rules: ${clean(f.file, 200)}:${f.line}: ${f.rule}: ${f.message}`);
  }
  say(
    `workflow-rules.result result=${findings.length === 0 ? "pass" : "fail"} files=${files} findings=${findings.length}`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}
