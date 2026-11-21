// workflow-rules (spec 07 §10.8, T-RV-40): each refusal planted in a workflow that is otherwise
// clean, the outline reader on the YAML shapes the workflows use, and this repository's own files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GATED_JOBS } from "../gate.mjs";
import {
  checkPins,
  checkRepository,
  checkWorkflow,
  child,
  EXPRESSION_OPEN as E,
  parseOutline,
  stripComment,
} from "../workflow-rules.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const NODE_SHA = "949feb2413d6458794dcd2491c4babbbce0c15c1";

/** A clean workflow; each test changes one thing. */
const CLEAN = `name: sample
on:
  pull_request:
  push:
    branches: [main]
permissions: {}
concurrency:
  group: sample-\${{ github.sha }}
  cancel-in-progress: true
env:
  TURBO_TELEMETRY_DISABLED: "1"
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@${NODE_SHA} # v7.1.0
        with: { node-version-file: .node-version, package-manager-cache: false }
      - name: Run
        env:
          VALUE: \${{ github.sha }}
        run: |
          echo "$VALUE" # a shell comment
`;

/**
 * The rules a workflow text breaks.
 * @param {string} text
 * @param {string} [file]
 */
function rules(text, file = "sample.yml") {
  return checkWorkflow(file, text).map((f) => f.rule);
}

/**
 * @param {string} from
 * @param {string} to
 */
function planted(from, to) {
  assert.ok(CLEAN.includes(from), `the clean workflow holds ${from}`);
  return CLEAN.replace(from, to);
}

describe("the outline reader", () => {
  it("strips comments outside quotes only", () => {
    assert.equal(stripComment("key: value # note"), "key: value ");
    assert.equal(stripComment('key: "a # b" # note'), 'key: "a # b" ');
    assert.equal(stripComment("key: 'it''s # x' # y"), "key: 'it''s # x' ");
    assert.equal(stripComment("# whole line"), "");
    assert.equal(stripComment("url: a#b"), "url: a#b");
  });

  it("reads mappings, sequence items, flow values and block scalars", () => {
    const { root, findings } = parseOutline("x.yml", CLEAN);
    assert.deepEqual(findings, []);
    const steps = child(
      /** @type {any} */ (child(/** @type {any} */ (child(root, "jobs")), "build")),
      "steps",
    );
    assert.equal(steps?.children.length, 3);
    const run = steps?.children[2] && child(steps.children[2], "run");
    assert.equal(run?.value, "|");
    assert.deepEqual(
      run?.scalar.map((s) => s.text),
      ['echo "$VALUE" # a shell comment', ""],
    );
  });

  it("flags a sequence item no deeper than its key, a tab, and a flow collection over two lines", () => {
    assert.ok(
      rules(planted("    steps:\n      - uses", "    steps:\n    - uses")).includes("indentation"),
    );
    assert.ok(
      rules(planted("    timeout-minutes: 5", "\ttimeout-minutes: 5")).includes("indentation"),
    );
    assert.ok(
      rules(planted("branches: [main]", "branches: [main,\n      next]")).includes(
        "flow-collection",
      ),
    );
  });
});

describe("checkWorkflow", () => {
  it("passes the clean workflow", () => {
    assert.deepEqual(checkWorkflow("sample.yml", CLEAN), []);
  });

  for (const trigger of [
    "pull_request_target",
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
    "workflow_run",
  ]) {
    it(`refuses the ${trigger} trigger, as a key and in a list`, () => {
      assert.ok(rules(planted("  pull_request:\n", `  ${trigger}:\n`)).includes("triggers"));
      assert.ok(
        rules(
          planted(
            "on:\n  pull_request:\n  push:\n    branches: [main]\n",
            `on: [push, ${trigger}]\n`,
          ),
        ).includes("triggers"),
      );
    });
  }

  it("refuses an expression inside a run value, inline or in a block", () => {
    assert.ok(
      rules(planted('echo "$VALUE"', `echo "${E} github.sha }}"`)).includes("expression-in-run"),
    );
    assert.ok(
      rules(planted('run: |\n          echo "$VALUE"', `run: echo ${E} github.sha }}`)).includes(
        "expression-in-run",
      ),
    );
  });

  for (const context of [
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.pull_request.head.ref",
    "github.head_ref",
    "github.event.comment.body",
    "github.event.review.body",
    "github.event.issue.title",
  ]) {
    it(`refuses a reference to ${context}`, () => {
      assert.ok(
        rules(planted(`VALUE: ${E} github.sha }}`, `VALUE: ${E} ${context} }}`)).includes(
          "untrusted-context",
        ),
      );
    });
  }

  it("refuses secrets: inherit", () => {
    const text = planted(
      "    timeout-minutes: 5\n",
      "    timeout-minutes: 5\n    secrets: inherit\n",
    );
    assert.ok(rules(text).includes("secrets-inherit"));
  });

  it("refuses a workflow without permissions: {}, concurrency or the telemetry switch", () => {
    assert.ok(
      rules(planted("permissions: {}\n", "permissions: write-all\n")).includes("permissions"),
    );
    assert.ok(rules(planted("permissions: {}\n", "")).includes("permissions"));
    assert.ok(
      rules(
        planted(
          `concurrency:\n  group: sample-${E} github.sha }}\n  cancel-in-progress: true\n`,
          "",
        ),
      ).includes("concurrency"),
    );
    assert.ok(
      rules(planted('TURBO_TELEMETRY_DISABLED: "1"', 'TURBO_TELEMETRY_DISABLED: "0"')).includes(
        "turbo-telemetry",
      ),
    );
  });

  it("refuses a job without a timeout, its own permissions, or the pinned runner", () => {
    assert.ok(rules(planted("    timeout-minutes: 5\n", "")).includes("timeout"));
    assert.ok(
      rules(planted("    permissions:\n      contents: read\n", "")).includes("job-permissions"),
    );
    assert.ok(rules(planted("runs-on: ubuntu-24.04", "runs-on: ubuntu-latest")).includes("runner"));
  });

  it("refuses a checkout without persist-credentials: false", () => {
    assert.ok(
      rules(planted("persist-credentials: false", "persist-credentials: true")).includes(
        "checkout-credentials",
      ),
    );
    assert.ok(
      rules(planted("        with:\n          persist-credentials: false\n", "")).includes(
        "checkout-credentials",
      ),
    );
    assert.deepEqual(
      rules(
        planted(
          "        with:\n          persist-credentials: false\n",
          "        with: { fetch-depth: 0, persist-credentials: false }\n",
        ),
      ),
      [],
    );
  });

  it("refuses setup-node's package-manager cache", () => {
    assert.ok(
      rules(planted("package-manager-cache: false", "package-manager-cache: true")).includes(
        "setup-node-cache",
      ),
    );
    assert.ok(
      rules(
        planted("package-manager-cache: false }", "package-manager-cache: false, cache: pnpm }"),
      ).includes("setup-node-cache"),
    );
  });

  it("refuses an unpinned, unversioned, third-party or docker:// action", () => {
    assert.ok(
      rules(planted(`actions/checkout@${SHA} # v7.0.1`, "actions/checkout@v7 # v7")).includes(
        "action-pin",
      ),
    );
    assert.ok(
      rules(planted(`actions/checkout@${SHA} # v7.0.1`, `actions/checkout@${SHA}`)).includes(
        "action-pin",
      ),
    );
    assert.ok(
      rules(
        planted(`actions/checkout@${SHA} # v7.0.1`, `oven-sh/setup-bun@${SHA} # v2.2.0`),
      ).includes("action-owner"),
    );
    assert.ok(
      rules(planted(`actions/checkout@${SHA} # v7.0.1`, "docker://alpine:3")).includes(
        "action-docker",
      ),
    );
    assert.ok(
      rules(planted(`actions/checkout@${SHA} # v7.0.1`, "./actions/local")).includes(
        "action-local",
      ),
    );
    assert.deepEqual(
      rules(
        planted(
          `actions/checkout@${SHA} # v7.0.1\n        with:\n          persist-credentials: false`,
          "./.github/actions/local",
        ),
      ),
      [],
    );
  });

  it("refuses a container or service image not pinned by digest", () => {
    const service = planted(
      "    steps:\n",
      "    services:\n      postgres:\n        image: postgres:18.7-trixie\n    steps:\n",
    );
    assert.ok(rules(service).includes("image-digest"));
    const pinned = service.replace(
      "postgres:18.7-trixie",
      `postgres:18.7-trixie@sha256:${"e".repeat(64)}`,
    );
    assert.deepEqual(rules(pinned), []);
    assert.ok(
      rules(planted("    steps:\n", "    container: node:26\n    steps:\n")).includes(
        "image-digest",
      ),
    );
  });

  it("allows a matrix key named image", () => {
    const matrix = planted(
      "    steps:\n",
      "    strategy:\n      matrix:\n        image: [api, edge]\n    steps:\n",
    );
    assert.deepEqual(rules(matrix), []);
  });

  it("refuses any cache in the release, dependency and nightly workflows", () => {
    const cache = planted(
      "      - name: Run\n",
      `      - uses: actions/cache/restore@${SHA} # v6.1.0\n        with:\n          path: x\n          key: y\n      - name: Run\n`,
    );
    assert.deepEqual(rules(cache, "ci.yml"), []);
    for (const file of ["release.yml", "dependencies.yml", "nightly.yml"]) {
      assert.ok(rules(cache, file).includes("no-cache"), file);
    }
  });

  it("refuses a cache of the review ledger in a workflow a pull request starts", () => {
    const ledger = planted(
      "      - name: Run\n",
      `      - uses: actions/cache/save@${SHA} # v6.1.0\n        with:\n          path: .fin-review/ledger.jsonl\n          key: y\n      - name: Run\n`,
    );
    assert.ok(rules(ledger, "ci.yml").includes("ledger-cache"));
    assert.deepEqual(rules(ledger.replace("  pull_request:\n", ""), "ci.yml"), []);
  });

  it("refuses a reusable-workflow job", () => {
    const text = planted(
      "    runs-on: ubuntu-24.04\n",
      "    runs-on: ubuntu-24.04\n    uses: ./.github/workflows/other.yml\n",
    );
    assert.ok(rules(text).includes("reusable-workflow"));
  });
});

describe("checkPins", () => {
  it("refuses a Postgres image that differs from compose.yaml's", (t) => {
    const root = tempDir(t);
    const digest = `sha256:${"e".repeat(64)}`;
    writeTree(root, {
      "compose.yaml": `services:\n  postgres:\n    image: postgres:18.7-trixie@${digest}\n`,
    });
    const same = `        image: postgres:18.7-trixie@${digest}\n`;
    const other = `        image: postgres:18.6-trixie@${digest}\n`;
    assert.deepEqual(checkPins(root, new Map([["ci.yml", same]])), []);
    assert.equal(checkPins(root, new Map([["ci.yml", other]]))[0]?.rule, "postgres-pin");
  });
});

describe("this repository", () => {
  it("has clean workflows, with the Postgres service on compose.yaml's digest", () => {
    const { files, findings } = checkRepository(ROOT);
    assert.ok(files >= 4, `found ${files} workflows`);
    assert.deepEqual(findings, []);
  });

  it("names the job the ruleset requires exactly commit-dates-utc, and gate needs it", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const { root } = parseOutline("ci.yml", text);
    const jobs = child(root, "jobs");
    assert.ok(jobs !== undefined && child(jobs, "commit-dates-utc") !== undefined);
    const gate = jobs === undefined ? undefined : child(jobs, "gate");
    assert.equal(
      gate === undefined ? undefined : child(gate, "needs")?.value,
      `[${GATED_JOBS.join(", ")}]`,
    );
    assert.equal(gate === undefined ? undefined : child(gate, "if")?.value, "always()");
    assert.equal(
      jobs === undefined
        ? undefined
        : child(/** @type {any} */ (child(jobs, "bun")), "continue-on-error")?.value,
      "true",
    );
  });

  it("runs plan, commit-dates-utc and gate on main's Node, never the change's .node-version", () => {
    for (const name of ["plan", "commit-dates-utc", "gate"]) {
      const setup = steps("ci.yml", name).find((s) => usesOf(s).startsWith("actions/setup-node@"));
      assert.equal(
        setup === undefined ? undefined : valueAt(setup, "with", "node-version-file"),
        "engine/.node-version",
        name,
      );
    }
  });

  it("checks the Node in check and build before any check script can run on it", () => {
    for (const name of ["check", "build"]) {
      const list = steps("ci.yml", name);
      const guard = list.findIndex((s) => runOf(s) === "node .github/scripts/node-check.mjs");
      const setup = list.findIndex((s) => usesOf(s).startsWith("actions/setup-node@"));
      assert.equal(guard, setup + 1, `${name}: the Node check follows setup-node`);
    }
  });
});

/**
 * A job's steps in one of this repository's workflows.
 * @param {string} file
 * @param {string} job
 * @returns {import("../workflow-rules.mjs").OutlineNode[]}
 */
function steps(file, job) {
  const text = readFileSync(join(ROOT, ".github", "workflows", file), "utf8");
  const { root } = parseOutline(file, text);
  const jobs = child(root, "jobs");
  const node = jobs === undefined ? undefined : child(jobs, job);
  const list = node === undefined ? undefined : child(node, "steps");
  assert.ok(list !== undefined, `${file} has the job ${job} with steps`);
  return list.children;
}

/**
 * The text at a path of keys under a node, unquoted, or undefined.
 * @param {import("../workflow-rules.mjs").OutlineNode} node
 * @param {...string} keys
 */
function valueAt(node, ...keys) {
  /** @type {import("../workflow-rules.mjs").OutlineNode | undefined} */
  let at = node;
  for (const key of keys) at = at === undefined ? undefined : child(at, key);
  return at?.value.replace(/^(["'])(.*)\1$/, "$2");
}

/** @param {import("../workflow-rules.mjs").OutlineNode} step */
function usesOf(step) {
  return valueAt(step, "uses") ?? "";
}

/** @param {import("../workflow-rules.mjs").OutlineNode} step */
function runOf(step) {
  return valueAt(step, "run") ?? "";
}
