// workflow-rules (spec 07 §10.8, T-RV-40): each refusal planted in a workflow that is otherwise
// clean, the outline reader on the YAML shapes the workflows use, and this repository's own files.
import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GATED_JOBS } from "../gate.mjs";
import {
  checkAction,
  checkPins,
  checkRepository,
  checkWorkflow,
  child,
  EXPRESSION_OPEN as E,
  parseFlow,
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
    // A quote opens a scalar only where YAML starts a node; inside a plain scalar it is a
    // character, so the comment after it is still one (as libyaml reads these lines).
    assert.equal(stripComment("x: a-'b # c"), "x: a-'b ");
    assert.equal(stripComment('x: a "b # c"'), 'x: a "b ');
    assert.equal(stripComment('- a-"b # c'), '- a-"b ');
    assert.equal(stripComment('x: {"a":"b # c"} # d'), 'x: {"a":"b # c"} ');
    assert.equal(stripComment('x: [a-\'b, "c # d"] # e'), 'x: [a-\'b, "c # d"] ');
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

  it("refuses an expression in a shell: value, which a runner runs as a command", () => {
    const text = planted(
      "        run: |\n",
      `        shell: bash -c "${E} env.X }} {0}"\n        run: |\n`,
    );
    assert.ok(rules(text).includes("expression-in-run"));
  });
});

describe("flow style reads as block style does", () => {
  const at = { line: 1, indent: 0, raw: "" };

  it("parses one-line flow mappings and sequences into the outline", () => {
    const parsed = parseFlow(
      `{ a: 1, "b, c": 'it''s', d: [x, "y: z", { e: f }], g: {}, h, url: https://example.com/x, }`,
      at,
    );
    assert.ok(parsed.ok && parsed.mapping);
    const keys = parsed.ok ? parsed.children.map((c) => `${c.key}=${c.value}`) : [];
    assert.deepEqual(keys, [
      "a=1",
      "b, c='it''s'",
      `d=[x, "y: z", { e: f }]`,
      "g={}",
      "h=",
      "url=https://example.com/x",
    ]);
    const d = parsed.ok ? parsed.children[2] : undefined;
    assert.deepEqual(
      d?.children.map((item) => item.children.map((c) => `${c.key ?? ""}:${c.value}`).join(",")),
      [":x", ':"y: z"', "e:f"],
    );
    const seq = parseFlow("[push, pull_request: { types: [opened] }]", at);
    assert.ok(seq.ok && !seq.mapping);
    assert.deepEqual(
      seq.ok ? seq.children.map((item) => item.children[0]?.key ?? item.children[0]?.value) : [],
      ["push", "pull_request"],
    );
  });

  it("refuses a flow collection it cannot read", () => {
    for (const [text, why] of [
      ["{ a: b", "unclosed"],
      ['[ "a ]', "unclosed"],
      ["{ a: *x }", "alias"],
      ["[ &x a ]", "alias"],
      ["{ a: !!str b }", "alias"],
      ["{ a: b } c", "syntax"],
      ["{ ? a : b }", "syntax"],
      ["{ [a]: b }", "syntax"],
      ["{ a: b c: d }", "syntax"],
      [`{ a: ci-${E} github.sha }} }`, "syntax"],
    ]) {
      const parsed = parseFlow(String(text), at);
      assert.deepEqual(parsed, { ok: false, why }, String(text));
    }
  });

  for (const trigger of [
    "pull_request_target",
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
    "workflow_run",
  ]) {
    it(`refuses the ${trigger} trigger in a flow mapping and in a block sequence`, () => {
      const on = "on:\n  pull_request:\n  push:\n    branches: [main]\n";
      assert.ok(rules(planted(on, `on: { push: {}, ${trigger}: {} }\n`)).includes("triggers"));
      assert.ok(rules(planted(on, `on:\n  - push\n  - ${trigger}\n`)).includes("triggers"));
    });
  }

  it("applies every step rule to a flow-style step and to a flow sequence of steps", () => {
    const step = `      - uses: actions/checkout@${SHA} # v7.0.1\n        with:\n          persist-credentials: false\n`;
    const flow = (/** @type {string} */ text) => planted(step, `${text}\n`);
    assert.deepEqual(
      rules(
        flow(
          `      - { uses: actions/checkout@${SHA}, with: { persist-credentials: false } } # v7.0.1`,
        ),
      ),
      [],
    );
    assert.ok(
      rules(flow(`      - { uses: someone/thing@${SHA} } # v1.0.0`)).includes("action-owner"),
    );
    assert.ok(
      rules(flow(`      - { uses: actions/checkout@${SHA} } # v7.0.1`)).includes(
        "checkout-credentials",
      ),
    );
    assert.ok(rules(flow(`      - { uses: actions/checkout@${SHA} }`)).includes("action-pin"));
    assert.ok(rules(flow(`      - { uses: "docker://alpine:3" }`)).includes("action-docker"));
    assert.ok(
      rules(flow(`      - { run: "echo ${E} github.sha }}" }`)).includes("expression-in-run"),
    );
    const steps = planted(
      "    steps:\n",
      `    steps: [{ uses: someone/thing@${SHA} }, { run: "echo ${E} github.sha }}" }] # v1.0.0\n    x-steps:\n`,
    );
    const found = rules(steps);
    assert.ok(found.includes("action-owner") && found.includes("expression-in-run"), found.join());
  });

  it("applies the job rules to a flow-style job, its services and its container", () => {
    const flowJob = planted(
      "    runs-on: ubuntu-24.04\n",
      "    runs-on: ubuntu-24.04\n    services: { pg: { image: postgres:18.7-trixie } }\n",
    );
    assert.ok(rules(flowJob).includes("image-digest"));
    const pinned = flowJob.replace("trixie }", `trixie@sha256:${"e".repeat(64)} }`);
    assert.deepEqual(rules(pinned), []);
    const call = planted(
      "jobs:\n",
      "jobs:\n  call: { uses: ./.github/workflows/x.yml, secrets: inherit, runs-on: ubuntu-24.04, timeout-minutes: 5, permissions: {} }\n",
    );
    const found = rules(call);
    assert.ok(
      found.includes("reusable-workflow") && found.includes("secrets-inherit"),
      found.join(),
    );
  });
});

describe("forms the reader refuses rather than misreads", () => {
  /** @type {[string, string, string, string][]} */
  const cases = [
    [
      "a run continued on the next line",
      'run: |\n          echo "$VALUE" # a shell comment',
      `run: echo\n          ${E} github.sha }}`,
      "multi-line-value",
    ],
    [
      "a run value started on the next line",
      'run: |\n          echo "$VALUE" # a shell comment',
      `run:\n          echo ${E} github.sha }}`,
      "expression-in-run",
    ],
    [
      "a quoted run value that does not close on its line",
      'run: |\n          echo "$VALUE" # a shell comment',
      `run: "echo\n          ${E} github.sha }}"`,
      "multi-line-value",
    ],
    [
      "a flow collection on a line of its own",
      "        with:\n          persist-credentials: false",
      "        with:\n          { persist-credentials: false }",
      "multi-line-value",
    ],
    [
      "an item's scalar followed by a key",
      "      - name: Run",
      "      - Run\n        name: x",
      "multi-line-value",
    ],
    ["an explicit key", "  pull_request:\n", "  ? pull_request_review\n", "explicit-key"],
    [
      "an alias as a step",
      "      - name: Run\n",
      "      - *step\n      - name: Run\n",
      "yaml-alias",
    ],
    ["an anchor", "  pull_request:\n", "  pull_request: &trigger {}\n", "yaml-alias"],
    ["a tag", "    timeout-minutes: 5", "    timeout-minutes: !!int 5", "yaml-alias"],
    ["a merge key", "    timeout-minutes: 5", "    <<: { timeout-minutes: 5 }", "yaml-alias"],
    [
      "a key given twice",
      `      - uses: actions/checkout@${SHA} # v7.0.1\n`,
      `      - uses: actions/checkout@${SHA} # v7.0.1\n        uses: someone/thing@${SHA} # v1.0.0\n`,
      "duplicate-key",
    ],
    ["a second document", "name: sample\n", "name: sample\n---\nname: other\n", "yaml-document"],
  ];
  for (const [what, from, to, rule] of cases) {
    it(`refuses ${what}`, () => {
      const found = rules(planted(from, to));
      assert.ok(found.includes(rule), `${what}: ${found.join(", ")}`);
    });
  }

  it("passes a document marker at the top and ordinary block scalars", () => {
    assert.deepEqual(rules(`---\n${CLEAN}`), []);
    const folded = planted(
      `          VALUE: ${E} github.sha }}\n`,
      `          VALUE: ${E} github.sha }}\n          OPTIONS: >-\n            --a\n\n            --b\n`,
    );
    assert.deepEqual(rules(folded), []);
  });
});

describe("line breaks, characters, escapes and block scalars YAML reads otherwise", () => {
  const THIRD_PARTY = `tj-actions/changed-files@${"a".repeat(40)} # v46.0.5`;
  const RUN = '        run: |\n          echo "$VALUE" # a shell comment\n';

  /** @type {[string, string][]} */
  const breaks = [
    ["a carriage return", "\r"],
    ["a next-line character (U+0085)", "\u0085"],
    ["a line separator (U+2028)", "\u{2028}"],
    ["a paragraph separator (U+2029)", "\u{2029}"],
  ];
  for (const [name, brk] of breaks) {
    it(`refuses ${name}, which YAML reads as a line break and the reader does not`, () => {
      const hidden = planted(RUN, `        run: echo hi${brk}      - uses: ${THIRD_PARTY}\n`);
      assert.ok(rules(hidden).includes("line-break"), name);
      const trigger = planted("  pull_request:\n", `  pull_request:${brk}  pull_request_review:\n`);
      assert.ok(rules(trigger).includes("line-break"), name);
    });
  }

  it("passes CRLF line endings, which both read alike", () => {
    assert.deepEqual(rules(CLEAN.replaceAll("\n", "\r\n")), []);
  });

  it("refuses a control, format or space character other than space and tab", () => {
    const save = `      - uses: actions/cache/save@${SHA} # v6.1.0\n        if: github.event_name == 'push' && runner.os != 'a\u{a0}#' || true\n        with:\n          path: x\n          key: y\n`;
    /** @type {[string, string][]} */
    const odd = [
      ["a no-break space before #", planted("      - name: Run\n", `${save}      - name: Run\n`)],
      ["a byte-order mark", `\u{feff}${CLEAN}`],
      [
        "a zero-width space in a key",
        planted("    timeout-minutes: 5", "    time\u{200b}out-minutes: 5"),
      ],
      ["an em space", planted("    timeout-minutes: 5", "    timeout-minutes:\u{2003}5")],
      ["a control character", planted("name: sample", "name: sam\u0001ple")],
      ["a bidirectional control", planted("name: sample", "name: sam\u{202e}ple")],
    ];
    for (const [what, text] of odd) {
      assert.ok(rules(text).includes("character"), what);
    }
  });

  /** @type {[string, string, string][]} */
  const escaped = [
    ["an escaped uses key", RUN, `      - "u\\x73es": ${THIRD_PARTY}\n`],
    [
      "an escaped uses key in a flow mapping",
      RUN,
      `      - { "u\\x73es": tj-actions/changed-files@${"a".repeat(40)} } # v46.0.5\n`,
    ],
    [
      "an escaped trigger in a flow sequence",
      "on:\n  pull_request:\n  push:\n    branches: [main]\n",
      'on: [pull_request, "pull_request_t\\x61rget"]\n',
    ],
    ["an escaped trigger key", "  pull_request:\n", '  "pull_request_t\\x61rget":\n'],
    [
      "an escaped trigger in a block sequence",
      "on:\n  pull_request:\n  push:\n    branches: [main]\n",
      'on:\n  - push\n  - "pull_request_t\\x61rget"\n',
    ],
    [
      "an escaped trigger value",
      "on:\n  pull_request:\n  push:\n    branches: [main]\n",
      'on: "pull_request_r\\x65view_comment"\n',
    ],
    ["an escaped run key", RUN, `        "r\\x75n": echo ${E} steps.x.outputs.y }}\n`],
    ["an escaped expression in run", RUN, `        run: "echo \\x24{{ github.sha }}"\n`],
    [
      "strangers' text behind an escape",
      `VALUE: ${E} github.sha }}`,
      `VALUE: "${E} github.event.pull_request.t\\x69tle }}"`,
    ],
    [
      "an escaped || in a cache save's condition",
      "      - name: Run\n",
      `      - uses: actions/cache/save@${SHA} # v6.1.0\n        if: "github.event_name == 'push' && true \\x7c\\x7c true"\n        with:\n          path: x\n          key: y\n      - name: Run\n`,
    ],
    ["an escaped quote", "name: sample", 'name: "sam\\"ple"'],
    // A quote inside a plain scalar first on the line (`a-'b`) is a character, not a scalar's
    // start: the escapes after it are still refused.
    [
      "an escaped cache save after a plain scalar holding a quote",
      "      - name: Run\n",
      `      - {name: save-'it, "u\\x73es": "actions/cache/save@${SHA}", with: {path: node_modules, key: deps}}\n      - name: Run\n`,
    ],
    [
      "strangers' text in a flow mapping after a plain scalar holding a quote",
      `        env:\n          VALUE: ${E} github.sha }}\n`,
      `        env: {A: x-'y, TITLE: "${E} github.event.pull_request.t\\x69tle }}"}\n`,
    ],
    [
      "strangers' text under a block key holding a quote",
      `VALUE: ${E} github.sha }}`,
      `X-'Y: "${E} github.event.pull_request.t\\x69tle }}"`,
    ],
    [
      "an escaped trigger after a plain scalar holding a quote",
      "on:\n  pull_request:\n  push:\n    branches: [main]\n",
      `on: {push: {branches: [release-'x]}, "pull_request_t\\x61rget": {}}\n`,
    ],
    [
      "an escaped third-party action after a plain scalar holding a quote",
      "      - name: Run\n",
      `      - {name: a-'b, "u\\x73es": tj-actions/changed-files@${"a".repeat(40)}}\n      - name: Run\n`,
    ],
    [
      "an escaped checkout after a plain scalar holding a quote",
      "      - name: Run\n",
      `      - {name: check-'out, "u\\x73es": "actions/checkout@${SHA}"}\n      - name: Run\n`,
    ],
    [
      "an escaped action after a plain scalar holding a double quote",
      "      - name: Run\n",
      `      - {name: a-"b, "u\\x73es": tj-actions/changed-files@${"a".repeat(40)}}\n      - name: Run\n`,
    ],
  ];
  for (const [what, from, to] of escaped) {
    it(`refuses ${what}`, () => {
      const found = rules(planted(from, to));
      assert.ok(found.includes("yaml-escape"), `${what}: ${found.join(", ")}`);
    });
  }

  it("keeps a backslash outside a double-quoted scalar, and reads a single quote's ''", () => {
    assert.deepEqual(rules(planted(RUN, "        run: printf 'a\\n' \"b\" # x\n")), []);
    assert.deepEqual(rules(planted("name: sample", "name: 'a\\b'")), []);
    const save = (/** @type {string} */ when) =>
      planted(
        "      - name: Run\n",
        `      - uses: actions/cache/save@${SHA} # v6.1.0\n        if: ${when}\n        with:\n          path: x\n          key: y\n      - name: Run\n`,
      );
    assert.deepEqual(rules(save("'github.event_name == ''push'''"), "ci.yml"), []);
    assert.ok(
      rules(save("'github.event_name == ''push'' || true'"), "ci.yml").includes("cache-save"),
    );
  });

  /** @type {[string, string, string][]} */
  const blocks = [
    [
      "a trigger as a block scalar",
      "on:\n  pull_request:\n  push:\n    branches: [main]\n",
      "on: >-\n  pull_request_review_comment\n",
    ],
    ["a trigger's value as a block scalar", "  pull_request:\n", "  pull_request: |\n    x\n"],
    [
      "secrets: inherit as a block scalar",
      "    timeout-minutes: 5\n",
      "    timeout-minutes: 5\n    secrets: >-\n      inherit\n",
    ],
    [
      "a step's condition as a block scalar",
      "      - name: Run\n",
      "      - name: Run\n        if: >-\n          always()\n",
    ],
    [
      "a uses: as a block scalar",
      `uses: actions/checkout@${SHA} # v7.0.1`,
      `uses: >-\n          actions/checkout@${SHA}`,
    ],
    ["a block scalar's indentation indicator", "run: |\n", "run: |2\n"],
  ];
  for (const [what, from, to] of blocks) {
    it(`refuses ${what}`, () => {
      const found = rules(planted(from, to));
      assert.ok(found.includes("block-scalar"), `${what}: ${found.join(", ")}`);
    });
  }

  it("keeps block scalars where no rule reads a scalar: run, options, description, with and env", () => {
    const service = planted(
      "    steps:\n",
      `    services:\n      pg:\n        image: postgres:18.7-trixie@sha256:${"e".repeat(64)}\n        options: >-\n          --health-cmd x\n    steps:\n`,
    );
    assert.deepEqual(rules(service), []);
    const withPath = planted(
      "        with:\n          persist-credentials: false\n",
      "        with:\n          persist-credentials: false\n          sparse-checkout: |\n            .github\n",
    );
    assert.deepEqual(rules(withPath), []);
    const action = `name: local\ndescription: |\n  a composite action\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: |\n        echo hi\n`;
    assert.deepEqual(checkAction("action.yml", action), []);
    assert.ok(
      checkAction("action.yml", action.replace("using: composite", "using: >-\n    docker"))
        .map((f) => f.rule)
        .includes("block-scalar"),
    );
  });
});

describe("strangers' text in other spellings", () => {
  for (const spelling of [
    "github.event['pull_request']['title']",
    'github.event["pull_request"].body',
    "github.EVENT.Pull_Request.TITLE",
    "github . head_ref",
    "github['head_ref']",
    "toJSON(github.event)",
    "toJSON(github.event.pull_request)",
    "toJSON( github )",
    "github.event.commits[0].message",
    "github.event.commits.*.author.email",
    "github.event.head_commit.message",
    "github.event.pull_request.head.label",
    "github.event.pull_request.head.repo.default_branch",
    "github.event.review_comment.body",
    "github.*",
  ]) {
    it(`refuses ${spelling}`, () => {
      const text = planted(`VALUE: ${E} github.sha }}`, `VALUE: ${E} ${spelling} }}`);
      assert.ok(rules(text).includes("untrusted-context"), spelling);
    });
  }

  it("refuses them in a YAML-quoted bracket, and keeps the safe fields", () => {
    const quoted = planted(
      `VALUE: ${E} github.sha }}`,
      `VALUE: '${E} github.event[''pull_request''][''title''] }}'`,
    );
    assert.ok(rules(quoted).includes("untrusted-context"));
    for (const safe of [
      "github.event.pull_request.number",
      "github.event.pull_request.head.sha",
      "github.event.pull_request.base.sha",
      "github.event.before",
      "github.event_name",
      "github.sha",
      "github.ref_name",
    ]) {
      const text = planted(`VALUE: ${E} github.sha }}`, `VALUE: ${E} ${safe} }}`);
      assert.deepEqual(rules(text), [], safe);
    }
  });
});

describe("the gate needs every job that can fail", () => {
  const gate = (/** @type {string} */ needs, /** @type {string} */ extra = "") =>
    `${CLEAN}  canary:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    continue-on-error: true\n    permissions: {}\n    steps:\n      - run: echo\n${extra}  gate:\n    needs: ${needs}\n    if: always()\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions: {}\n    steps:\n      - run: echo\n`;

  it("passes a gate that needs every blocking job, the canary left out", () => {
    assert.deepEqual(rules(gate("[build]")), []);
    assert.deepEqual(rules(gate("\n      - build")), []);
  });

  it("refuses a job left out of gate's needs, however needs is written", () => {
    const extra =
      "  lint:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    permissions: {}\n    steps:\n      - run: echo\n";
    for (const needs of ["[build]", "build", "\n      - build"]) {
      const found = checkWorkflow("ci.yml", gate(needs, extra));
      assert.ok(
        found.some((f) => f.rule === "gate-needs" && f.message.includes("lint")),
        needs,
      );
    }
  });

  it("refuses a gate that does not run always()", () => {
    for (const when of ["success()", `${E} !cancelled() }}`, ""]) {
      const text = gate("[build]").replace(
        "    if: always()\n",
        when === "" ? "" : `    if: ${when}\n`,
      );
      assert.ok(rules(text).includes("gate-needs"), when);
    }
    assert.deepEqual(rules(gate("[build]").replace("if: always()", `if: ${E} always() }}`)), []);
  });
});

describe("caches a pull request's run could leave", () => {
  const save = (/** @type {string} */ when, /** @type {string} */ action = "actions/cache/save") =>
    planted(
      "      - name: Run\n",
      `      - uses: ${action}@${SHA} # v6.1.0\n${when === "" ? "" : `        if: ${when}\n`}        with:\n          path: .turbo/cache\n          key: y\n      - name: Run\n`,
    );

  it("refuses a save that can run on a pull request, and actions/cache's own save", () => {
    for (const when of [
      "",
      "always()",
      "github.event_name == 'push' || true",
      "github.ref == 'refs/heads/main'",
    ]) {
      assert.ok(rules(save(when), "ci.yml").includes("cache-save"), when);
    }
    assert.ok(rules(save("", "actions/cache"), "ci.yml").includes("cache-save"));
  });

  it("passes a save on push only, and any save in a workflow no pull request starts", () => {
    assert.deepEqual(rules(save("github.event_name == 'push'"), "ci.yml"), []);
    assert.deepEqual(
      rules(save("github.event_name == 'push' && steps.c.outputs.cache-hit != 'true'"), "ci.yml"),
      [],
    );
    assert.deepEqual(rules(save("").replace("  pull_request:\n", ""), "ci.yml"), []);
  });
});

describe("actions under .github/", () => {
  const ACTION = `name: local
description: a composite action
runs:
  using: composite
  steps:
    - uses: actions/checkout@${SHA} # v7.0.1
      with:
        persist-credentials: false
    - shell: bash
      env:
        VALUE: \${{ inputs.value }}
      run: echo "$VALUE"
`;

  it("keeps the step and text rules in a composite action", () => {
    assert.deepEqual(checkAction("action.yml", ACTION), []);
    const actionRules = (/** @type {string} */ text) =>
      checkAction("action.yml", text).map((f) => f.rule);
    assert.ok(
      actionRules(ACTION.replace(`actions/checkout@${SHA}`, "someone/thing@main")).includes(
        "action-pin",
      ),
    );
    assert.ok(
      actionRules(ACTION.replace(`actions/checkout@${SHA}`, `someone/thing@${SHA}`)).includes(
        "action-owner",
      ),
    );
    assert.ok(
      actionRules(ACTION.replace('echo "$VALUE"', `echo "${E} inputs.value }}"`)).includes(
        "expression-in-run",
      ),
    );
    assert.ok(
      actionRules(
        ACTION.replace(`${E} inputs.value }}`, `${E} github.event.pull_request.title }}`),
      ).includes("untrusted-context"),
    );
    assert.ok(
      actionRules("runs:\n  using: docker\n  image: Dockerfile\n").includes("action-docker"),
    );
    assert.ok(actionRules("name: x\n").includes("action"));
  });

  it("reads every action and workflow under .github/, and refuses a link there", (t) => {
    const root = tempDir(t);
    writeTree(root, {
      ".github/workflows/sample.yml": CLEAN,
      ".github/workflows/action.yml": CLEAN.replace(
        "  pull_request:\n",
        "  pull_request_target:\n",
      ),
      ".github/workflows/old/ignored.yml": "not: a workflow GitHub runs\n",
      ".github/actions/thing/action.yml": ACTION.replace(
        `actions/checkout@${SHA}`,
        "someone/thing@main",
      ),
      ".github/dependabot.yml": "version: 2\n",
    });
    symlinkSync("/etc/hosts", join(root, ".github", "actions", "linked.yml"));
    const { files, findings } = checkRepository(root);
    assert.equal(files, 3);
    const where = findings.map((f) => `${f.file}:${f.rule}`);
    assert.ok(where.includes(".github/actions/thing/action.yml:action-pin"), where.join());
    assert.ok(where.includes(".github/workflows/action.yml:triggers"), where.join());
    assert.ok(where.includes(".github/actions/linked.yml:link"), where.join());
    assert.ok(
      !where.some((w) => w.includes("ignored.yml") || w.includes("dependabot")),
      where.join(),
    );
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

  it("runs the control-path checks in check directly, before the install, not only via package.json", () => {
    const list = steps("ci.yml", "check");
    const install = list.findIndex((s) => runOf(s) === "pnpm install --frozen-lockfile");
    assert.ok(install > 0, "check installs");
    for (const script of ["scripts/check-supply-chain.mjs", "scripts/public-safety.mjs"]) {
      const at = list.findIndex((s) => runOf(s) === `node ${script}`);
      assert.ok(at >= 0 && at < install, `check runs node ${script} before the install`);
    }
  });

  it("saves a cache on push to main only, and restores one only after its scope check", () => {
    let saves = 0;
    let restores = 0;
    for (const name of ["check", "db", "build", "bun"]) {
      const list = steps("ci.yml", name);
      const scope = list.findIndex((s) => runOf(s) === "node .github/scripts/cache-scope.mjs");
      for (const [i, step] of list.entries()) {
        const uses = usesOf(step);
        if (uses.startsWith("actions/cache/save@")) {
          saves++;
          assert.match(valueAt(step, "if") ?? "", /^github\.event_name == 'push' && [^|]*$/, name);
        } else if (uses.startsWith("actions/cache/restore@")) {
          restores++;
          assert.ok(scope >= 0 && scope < i, `${name}: the scope check runs before each restore`);
          assert.equal(valueAt(step, "if"), "steps.cache-scope.outputs.restore == 'true'", name);
          assert.doesNotMatch(
            child(step, "with")
              ?.children.find((c) => c.key === "restore-keys")
              ?.scalar.map((s) => s.text)
              .join("\n") ?? "",
            /ref_name/,
            `${name}: main's entries only`,
          );
        } else {
          assert.ok(!uses.startsWith("actions/cache"), `${name}: ${uses} saves in its post step`);
        }
      }
    }
    assert.equal(saves, 3, "check saves the store and Turborepo's cache, build Turborepo's");
    assert.equal(restores, 6);
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
