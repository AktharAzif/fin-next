#!/usr/bin/env node
// workflow-rules (spec 07 §10.8; spec 01 §5.1; ARCHITECTURE §11.2, §11.5; EXECUTION §2.3). A
// control path, run by ci.yml's static job beside zizmor and actionlint. It refuses, in every
// workflow under .github/workflows:
//   - the triggers pull_request_target, issue_comment, pull_request_review,
//     pull_request_review_comment and workflow_run (no comment or review trigger, ever);
//   - `${{ }}` inside a run: value (values reach a shell through env: only);
//   - a reference to github.event.pull_request.title, .body, .head.ref, github.head_ref,
//     github.event.comment, github.event.review or github.event.issue (strangers' text, CI-15);
//   - `secrets: inherit`;
//   - a workflow without a top-level `permissions: {}`, `concurrency:` or
//     `TURBO_TELEMETRY_DISABLED: "1"` in its top-level env;
//   - a job without `timeout-minutes`, without its own `permissions`, or on a runner other than
//     ubuntu-24.04;
//   - a checkout without `persist-credentials: false`; a setup-node without
//     `package-manager-cache: false`, or with `cache:`;
//   - a `uses:` that is not a GitHub-owned action (actions/*, github/*) or a local action, or is
//     not pinned to a 40-character commit SHA with its version in a comment; a docker:// action;
//   - a container or service image not pinned by digest;
//   - a cache in release.yml, dependencies.yml or nightly.yml (release builds and scans restore no
//     cache, ARCHITECTURE §11.3), and a cache of the review ledger in a workflow a pull request
//     can start (spec 07 §10.3);
//   - a sequence item indented no deeper than its key, a tab in the indentation, and a flow
//     collection that does not close on its own line (the reader below relies on all three);
// and, across files, a Postgres image in a workflow that differs from compose.yaml's.
//
// The reader is a small outline of YAML's block style, the style these files are written in;
// actionlint parses them fully, so a file this reader misreads still fails CI there.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clean, say } from "./lib/ci.mjs";

/** @typedef {{ file: string, line: number, rule: string, message: string }} Finding */
/**
 * @typedef {{
 *   key: string | null, value: string, raw: string, line: number, indent: number,
 *   item: boolean, children: OutlineNode[], scalar: { line: number, text: string }[],
 * }} OutlineNode
 */

export const FORBIDDEN_TRIGGERS = [
  "pull_request_target",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_run",
];
export const UNTRUSTED_CONTEXTS = [
  /github\.event\.pull_request\.title/,
  /github\.event\.pull_request\.body/,
  /github\.event\.pull_request\.head\.ref/,
  /github\.head_ref/,
  /github\.event\.comment/,
  /github\.event\.review/,
  /github\.event\.issue/,
];
export const RUNNER = "ubuntu-24.04";
/** The opening of a GitHub expression, spelled so that no linter reads it as a template. */
export const EXPRESSION_OPEN = `${"$"}{{`;
export const ACTION_OWNERS = new Set(["actions", "github"]);
/** Workflows that restore no cache (release builds and scans, ARCHITECTURE §11.3). */
export const NO_CACHE_WORKFLOWS = new Set(["release.yml", "dependencies.yml", "nightly.yml"]);

const KEY = /^("[^"]*"|'[^']*'|[^\s"'#:{}[\],&*!|>%@`][^:#]*?)\s*:(?=\s|$)/;
const PINNED = /^([\w.-]+)\/([\w.-]+)(\/[\w./-]+)?@([0-9a-f]{40})$/;

/**
 * The text of a line before its comment: a `#` at the start or after a space, outside quotes.
 * @param {string} line
 * @returns {string}
 */
export function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== "") {
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") i++;
        else quote = "";
      } else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const before = line.slice(0, i).trimEnd();
      // A quote opens a scalar only where one can start: after a key, an item, or a flow token.
      if (before === "" || /[:\-[{,]$/.test(before)) quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) return line.slice(0, i);
  }
  return line;
}

/**
 * @param {string} key
 * @returns {string}
 */
function unquote(key) {
  const t = key.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
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
  return { key, value, raw, line, indent, item, children: [], scalar: [] };
}

/**
 * Reads the block-style outline of a YAML file: mappings, sequences, inline values and block
 * scalars (kept as lines). Structure problems the reader depends on are returned as findings.
 * @param {string} file
 * @param {string} text
 * @returns {{ root: OutlineNode, findings: Finding[] }}
 */
export function parseOutline(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  const root = makeNode(null, "", "", 0, -1, false);
  /** @type {OutlineNode[]} */
  const stack = [root];
  const top = () => /** @type {OutlineNode} */ (stack.at(-1));
  /** @type {{ node: OutlineNode, parentIndent: number } | null} */
  let block = null;
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
      findings.push({ file, line, rule: "indentation", message: "a tab in the indentation" });
    }
    const content = stripComment(raw);
    if (content.trim() === "") continue;
    let col = lead.length;
    let rest = content.slice(col).trimEnd();
    if (rest === "---" || rest === "...") continue;
    while (rest === "-" || rest.startsWith("- ")) {
      const parent = top();
      if (parent.key !== null && !parent.item && parent.value === "" && parent.indent >= col) {
        findings.push({
          file,
          line,
          rule: "indentation",
          message: "indent a sequence item deeper than its key",
        });
      }
      while (top().indent >= col) stack.pop();
      const item = makeNode(null, "", raw, line, col, true);
      top().children.push(item);
      stack.push(item);
      const after = rest === "-" ? "" : rest.slice(2);
      col += 2 + (after.length - after.trimStart().length);
      rest = after.trimStart();
    }
    if (rest === "") continue;
    while (top().indent >= col) stack.pop();
    const match = KEY.exec(rest);
    if (match !== null) {
      const value = rest.slice(match[0].length).trim();
      const node = makeNode(unquote(match[1] ?? ""), value, raw, line, col, false);
      top().children.push(node);
      stack.push(node);
      if (/^[|>][1-9+-]*$/.test(value)) block = { node, parentIndent: col };
      if (/^[[{]/.test(value) && !balanced(value)) {
        findings.push({
          file,
          line,
          rule: "flow-collection",
          message: "close a flow collection on the line that opens it",
        });
      }
    } else {
      top().children.push(makeNode(null, rest, raw, line, col, false));
    }
  }
  return { root, findings };
}

/**
 * Whether the brackets of a flow collection balance on one line (quotes respected).
 * @param {string} text
 */
function balanced(text) {
  let depth = 0;
  let quote = "";
  for (const c of text) {
    if (quote !== "") {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth === 0;
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
 * Whether a mapping (block, or flow on one line) sets `key` to `value`.
 * @param {OutlineNode | undefined} node
 * @param {string} key
 * @param {string} value
 */
function sets(node, key, value) {
  if (node === undefined) return false;
  const inner = child(node, key);
  if (inner !== undefined) return unquote(inner.value) === value;
  const flow = new RegExp(`(?:^\\{|,)\\s*${key}\\s*:\\s*["']?${value}["']?\\s*(?:,|\\})`);
  return flow.test(node.value.replace(/\s+/g, " "));
}

/**
 * Whether a mapping (block, or flow on one line) has `key` at all.
 * @param {OutlineNode | undefined} node
 * @param {string} key
 */
function has(node, key) {
  if (node === undefined) return false;
  return child(node, key) !== undefined || new RegExp(`(?:^\\{|,)\\s*${key}\\s*:`).test(node.value);
}

/**
 * The trigger names under `on:`.
 * @param {OutlineNode | undefined} on
 * @returns {{ name: string, line: number }[]}
 */
function triggers(on) {
  if (on === undefined) return [];
  if (on.value !== "") {
    return on.value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((name) => ({ name: unquote(name), line: on.line }))
      .filter((t) => t.name !== "");
  }
  return on.children.map((c) => ({ name: c.key ?? unquote(c.value), line: c.line }));
}

/**
 * Checks one workflow file.
 * @param {string} file the file's name under .github/workflows
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
  for (const node of walk(root)) {
    const texts = [
      { line: node.line, text: `${node.key ?? ""} ${node.value}` },
      ...node.scalar.map((s) => ({ line: s.line, text: s.text })),
    ];
    for (const { line, text: t } of texts) {
      for (const pattern of UNTRUSTED_CONTEXTS) {
        if (pattern.test(t)) {
          add(line, "untrusted-context", `${pattern.source} is strangers' text and never read`);
        }
      }
    }
    if (node.key === "secrets" && unquote(node.value) === "inherit") {
      add(node.line, "secrets-inherit", "`secrets: inherit` is refused");
    }
    if (node.key === "run") {
      const runTexts = [{ line: node.line, text: node.value }, ...node.scalar];
      for (const { line, text: t } of runTexts) {
        if (t.includes(EXPRESSION_OPEN)) {
          add(
            line,
            "expression-in-run",
            `pass values to run: through env:, never an expression (${EXPRESSION_OPEN} }})`,
          );
        }
      }
    }
  }

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
    if (!ref.startsWith("./.github/")) add("action-local", "a local action lives under .github/");
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
    if (NO_CACHE_WORKFLOWS.has(file)) {
      add("no-cache", `${file} restores and saves no cache (ARCHITECTURE §11.3)`);
    }
    const path = child(withNode ?? step, "path");
    const paths = [path?.value ?? "", ...(path?.scalar.map((s) => s.text) ?? [])].join("\n");
    if (context.pullRequests && paths.includes(".fin-review/ledger")) {
      add("ledger-cache", "the review ledger is never cached by a workflow a pull request starts");
    }
  }
  return findings;
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
 * Checks every workflow under <root>/.github/workflows.
 * @param {string} root
 * @returns {{ files: number, findings: Finding[] }}
 */
export function checkRepository(root) {
  const dir = join(root, ".github", "workflows");
  /** @type {Map<string, string>} */
  const workflows = new Map();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (/\.ya?ml$/i.test(name)) workflows.set(name, readFileSync(join(dir, name), "utf8"));
    }
  }
  /** @type {Finding[]} */
  const findings = [];
  for (const [file, text] of workflows) findings.push(...checkWorkflow(file, text));
  findings.push(...checkPins(root, workflows));
  return { files: workflows.size, findings };
}

if (import.meta.main) {
  const index = process.argv.indexOf("--root");
  const root = index > 0 ? (process.argv[index + 1] ?? ".") : process.cwd();
  const { files, findings } = checkRepository(root);
  for (const f of findings) {
    say(`workflow-rules: .github/workflows/${f.file}:${f.line}: ${f.rule}: ${f.message}`);
  }
  say(
    `workflow-rules.result result=${findings.length === 0 ? "pass" : "fail"} files=${files} findings=${findings.length}`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}
