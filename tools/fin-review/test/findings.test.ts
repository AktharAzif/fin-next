// Finding validation in code (spec 07 §2.8 rules 1 to 4 and 6; T-RV-13), and the small schema
// checker it rests on.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { outputProblem, validateOutput } from "../src/review/findings.ts";
import type { FileSource, ValidationContext } from "../src/review/findings.ts";
import { checklistIds, loadProcedure, sessionSchema } from "../src/review/procedure.ts";
import { SchemaDefinitionError, compileSchema } from "../src/review/schema.ts";

const PROCEDURE = loadProcedure(fileURLToPath(new URL("../../../docs/review/", import.meta.url)));
const ITEMS = checklistIds(PROCEDURE, "security");
const FILES: Record<string, string> = {
  "src/a.ts": "export function f(x: number): number {\n  return x + 1;\n}\n",
  "src/crlf.ts": "const a = 1;\r\nconst b = 2;\r\n",
  "src/other.ts": "export const other = 1;\n",
};

const files: FileSource = { text: (path) => (Object.hasOwn(FILES, path) ? (FILES[path] ?? "").replace(/\r\n/g, "\n") : null) };

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { schema: sessionSchema(PROCEDURE, "security", null, ITEMS, []), checklist: ITEMS, allowed: new Set(["src/a.ts", "src/crlf.ts"]), files, ...overrides };
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lens: "security",
    class: "unclassified",
    severity: "high",
    title: "x + 1 overflows",
    where: [{ path: "src/a.ts", startLine: 1, endLine: 3 }],
    quotes: [{ path: "src/a.ts", text: "return x + 1;" }],
    claim: "c",
    scenario: "s",
    testShouldFail: "t",
    preExisting: false,
    ...overrides,
  };
}

function output(findings: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { done: true, checked: ITEMS.map((item) => ({ item, verdict: "ok" })), findings, procedureGaps: [], ...overrides };
}

function problem(value: unknown, c: ValidationContext = ctx()): string | null {
  return outputProblem(validateOutput(value, c));
}

describe("finding validation (T-RV-13)", () => {
  it("accepts a valid output", () => {
    assert.equal(problem(output([finding()])), null);
    assert.equal(problem(output([])), null);
  });

  it("rejects, one at a time: an unknown field, a missing path, a line past the end, a quote not in the file, a field over its cap, an incomplete checked", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["unknown field", output([finding({ confidence: 0.9 })]), /confidence is not allowed/],
      ["unknown top-level field", output([], { notes: "x" }), /notes is not allowed/],
      ["missing path", output([finding({ where: [{ path: "src/nope.ts", startLine: 1, endLine: 1 }] })]), /not a file of the reviewed tree/],
      ["line past the end", output([finding({ where: [{ path: "src/a.ts", startLine: 2, endLine: 4 }] })]), /past the end \(3 lines\)/],
      ["start after end", output([finding({ where: [{ path: "src/a.ts", startLine: 3, endLine: 2 }] })]), /after endLine/],
      ["quote not in the file", output([finding({ quotes: [{ path: "src/a.ts", text: "return x - 1;" }] })]), /not an exact substring/],
      ["blank quote", output([finding({ quotes: [{ path: "src/a.ts", text: "   " }] })]), /blank/],
      ["quote of a missing file", output([finding({ quotes: [{ path: "src/zzz.ts", text: "x" }] })]), /not a file of the reviewed tree/],
      ["title over 120", output([finding({ title: "t".repeat(121) })]), /longer than 120/],
      ["claim over 600", output([finding({ claim: "c".repeat(601) })]), /longer than 600/],
      ["quote over 300", output([finding({ quotes: [{ path: "src/a.ts", text: "q".repeat(301) }] })]), /longer than 300/],
      ["six places", output([finding({ where: Array(6).fill({ path: "src/a.ts", startLine: 1, endLine: 1 }) })]), /more than 5 items/],
      ["no quotes", output([finding({ quotes: [] })]), /fewer than 1 items/],
      ["41 findings", output(Array(41).fill(finding())), /more than 40 items/],
      ["another lens", output([finding({ lens: "quality" })]), /not one of the allowed values/],
      ["a profile on a lens finding", output([finding({ profile: "generic" })]), /profile is not allowed/],
      ["an unknown class", output([finding({ class: "C1" })]), /does not match the pattern/],
      ["an unknown severity", output([finding({ severity: "info" })]), /not one of the allowed values/],
      ["incomplete checked", output([], { checked: [{ item: "ALL-01", verdict: "ok" }] }), /checked omits SEC-01/],
      ["an unknown item", output([], { checked: [...ITEMS.map((item) => ({ item, verdict: "ok" })), { item: "XXX-99", verdict: "ok" }] }), /not one of the allowed values/],
      ["done false", output([], { done: false }), /done: false/],
      ["a path outside what the session was given", output([finding({ where: [{ path: "src/other.ts", startLine: 1, endLine: 1 }], quotes: [{ path: "src/other.ts", text: "other" }] })]), /outside what the session was given/],
      ["not an object", [], /must be object/],
    ];
    for (const [label, value, pattern] of cases) {
      const found = problem(value);
      assert.ok(found !== null, label);
      assert.match(found, pattern, label);
    }
  });

  it("matches a quote in a CRLF file after CRLF becomes LF", () => {
    assert.equal(problem(output([finding({ where: [{ path: "src/crlf.ts", startLine: 1, endLine: 2 }], quotes: [{ path: "src/crlf.ts", text: "const a = 1;\nconst b = 2;" }] })])), null);
    assert.equal(problem(output([finding({ where: [{ path: "src/crlf.ts", startLine: 1, endLine: 2 }], quotes: [{ path: "src/crlf.ts", text: "const a = 1;\r\nconst b = 2;" }] })])), null);
  });

  it("a whole-tree session (joins, attack) may name any file of the tree", () => {
    const value = output([finding({ where: [{ path: "src/other.ts", startLine: 1, endLine: 1 }], quotes: [{ path: "src/other.ts", text: "other" }] })]);
    assert.equal(problem(value, ctx({ allowed: null })), null);
  });

  it("judges findings one by one: the valid ones stay valid beside an invalid one", () => {
    const validated = validateOutput(output([finding(), finding({ quotes: [{ path: "src/a.ts", text: "nowhere" }] })]), ctx());
    assert.deepEqual(validated.findings.map((check) => check.ok), [true, false]);
    assert.deepEqual(validated.structureProblems, []);
  });

  it("an attack session's findings need its profile", () => {
    const items = checklistIds(PROCEDURE, "attack");
    const c = ctx({ schema: sessionSchema(PROCEDURE, "attack", "pipeline", items, []), checklist: items, allowed: null });
    const out = (f: Record<string, unknown>) => ({ ...output([f]), checked: items.map((item) => ({ item, verdict: "ok" })) });
    assert.equal(problem(out(finding({ lens: "attack", profile: "pipeline" })), c), null);
    assert.match(problem(out(finding({ lens: "attack" })), c) ?? "", /missing "profile"/);
    assert.match(problem(out(finding({ lens: "attack", profile: "generic" })), c) ?? "", /not one of the allowed values/);
  });

  it("a prior blocker's fix claim is accepted only with a valid quote of the fix; a fabricated quote rejects the output, a claim the engine cannot take keeps it open", () => {
    const ids = ["P1", "P2", "P3", "P4"];
    // Line 2 of src/a.ts changed since each blocker was found.
    const changed = new Map([["src/a.ts", new Set([2])]]);
    const c = ctx({ schema: sessionSchema(PROCEDURE, "security", null, ITEMS, ids), fixScopes: new Map(ids.map((id) => [id, { files: changed, quotedElsewhere: [] }])) });
    const validated = validateOutput(
      output([], {
        priorBlockers: [
          { id: "P1", status: "fixed", fixWhere: { path: "src/a.ts", startLine: 2, endLine: 2 }, fixQuote: { path: "src/a.ts", text: "return x + 1;" } },
          { id: "P2", status: "fixed" },
          { id: "P3", status: "fixed", fixWhere: { path: "src/a.ts", startLine: 1, endLine: 1 }, fixQuote: { path: "src/a.ts", text: "export function f" } },
          { id: "P4", status: "fixed", fixWhere: { path: "src/a.ts", startLine: 2, endLine: 2 }, fixQuote: { path: "src/a.ts", text: "invented" } },
        ],
      }),
      c,
    );
    assert.deepEqual(validated.prior.map((check) => [check.id, check.status]), [["P1", "fixed"], ["P2", "open"], ["P3", "open"], ["P4", "open"]]);
    // P2 (no quote) and P3 (a true quote of an unchanged line) stay open without failing the output;
    // P4's quote is not in its file, which is a wrong answer (rule 3), so the output is retried.
    assert.deepEqual(validated.prior.map((check) => check.notAccepted.length > 0), [false, true, true, false]);
    assert.match(outputProblem(validated) ?? "", /prior blocker P4: quote is not an exact substring/);
    const truthful = validateOutput(output([], { priorBlockers: [{ id: "P3", status: "fixed", fixWhere: { path: "src/a.ts", startLine: 1, endLine: 1 }, fixQuote: { path: "src/a.ts", text: "export function f" } }] }), c);
    assert.equal(outputProblem(truthful), null, "a true quote the engine cannot take is no reason to reject the lens");
    // Without prior blockers the schema has no priorBlockers field at all.
    assert.match(problem(output([], { priorBlockers: [] })) ?? "", /priorBlockers is not allowed/);
  });

  it("where the quoted code now also appears refuses no claim: the fix check judges it, and a file it went to may hold the fix", () => {
    const scope = { files: new Map([["src/a.ts", new Set([2])], ["src/other.ts", new Set([1])]]), quotedElsewhere: ["src/other.ts"] };
    const c = ctx({ schema: sessionSchema(PROCEDURE, "security", null, ITEMS, ["P1"]), fixScopes: new Map([["P1", scope]]) });
    const claim = (where: Record<string, unknown>, quote: Record<string, unknown>) => validateOutput(output([], { priorBlockers: [{ id: "P1", status: "fixed", fixWhere: where, fixQuote: quote }] }), c).prior[0];
    assert.equal(claim({ path: "src/a.ts", startLine: 2, endLine: 2 }, { path: "src/a.ts", text: "return x + 1;" })?.status, "fixed", "a fix in the file the blocker names");
    assert.equal(claim({ path: "src/other.ts", startLine: 1, endLine: 1 }, { path: "src/other.ts", text: "export const other = 1;" })?.status, "fixed", "a fix where the quoted code went");
  });

  it("a quoted fix must come from its own file, within its lines, and touch a line changed since the blocker was found", () => {
    const fixed = (where: Record<string, unknown>, quote: Record<string, unknown>, changed: Map<string, Set<number>>) => {
      const c = ctx({ schema: sessionSchema(PROCEDURE, "security", null, ITEMS, ["P1"]), fixScopes: new Map([["P1", { files: changed, quotedElsewhere: [] }]]) });
      const check = validateOutput(output([], { priorBlockers: [{ id: "P1", status: "fixed", fixWhere: where, fixQuote: quote }] }), c).prior[0];
      return check === undefined ? undefined : { status: check.status, problems: [...check.problems, ...check.notAccepted] };
    };
    const line2 = { path: "src/a.ts", startLine: 2, endLine: 2 };
    const quote = { path: "src/a.ts", text: "return x + 1;" };
    assert.equal(fixed(line2, quote, new Map([["src/a.ts", new Set([2])]]))?.status, "fixed");
    // Nothing changed since the blocker was found: the line it named is no fix of itself.
    assert.match(fixed(line2, quote, new Map([["src/a.ts", new Set()]]))?.problems[0] ?? "", /touches no line of src\/a\.ts that changed since the blocker was found/);
    // A change elsewhere in the tree does not make an unchanged line a fix.
    assert.equal(fixed(line2, quote, new Map([["src/other.ts", new Set([1])], ["src/a.ts", new Set([3])]]))?.status, "open");
    // The quote must come from the file fixWhere names, and from within its lines.
    assert.match(fixed({ path: "src/other.ts", startLine: 1, endLine: 1 }, quote, new Map([["src/other.ts", new Set([1])]]))?.problems[0] ?? "", /quoted from "src\/a\.ts", not from "src\/other\.ts"/);
    // fixWhere must be a file tied to the blocker (the map's keys): a changed line of another file,
    // even one the session quotes exactly, closes nothing.
    const otherLine = { path: "src/other.ts", startLine: 1, endLine: 1 };
    const otherQuote = { path: "src/other.ts", text: "export const other = 1;" };
    assert.match(fixed(otherLine, otherQuote, new Map([["src/a.ts", new Set([2])]]))?.problems[0] ?? "", /"src\/other\.ts", which is not tied to the blocker/);
    assert.equal(fixed(otherLine, otherQuote, new Map([["src/a.ts", new Set([2])], ["src/other.ts", new Set([1])]]))?.status, "fixed", "a file tied to the blocker may hold the fix");
    assert.match(fixed(line2, quote, new Map())?.problems[0] ?? "", /not tied to the blocker/, "a blocker with no tied file closes on no quote");
    assert.match(fixed({ path: "src/a.ts", startLine: 3, endLine: 3 }, quote, new Map([["src/a.ts", new Set([3])]]))?.problems[0] ?? "", /not within src\/a\.ts:3-3/);
    // A wide fixWhere does not help: the quoted text itself must touch a changed line.
    assert.equal(fixed({ path: "src/a.ts", startLine: 1, endLine: 3 }, quote, new Map([["src/a.ts", new Set([3])]]))?.status, "open");
    assert.equal(fixed({ path: "src/a.ts", startLine: 1, endLine: 3 }, { path: "src/a.ts", text: "x + 1;\n}" }, new Map([["src/a.ts", new Set([3])]]))?.status, "fixed");
  });
});

describe("the schema checker (spec 07 §2.8 rule 1: no library)", () => {
  it("refuses a keyword outside its subset when compiling, so none is ignored", () => {
    for (const schema of [{ type: "object", oneOf: [] }, { $ref: "#/x" }, { type: "string", format: "email" }, { type: "nope" }, { pattern: "(" }]) {
      assert.throws(() => compileSchema(schema), SchemaDefinitionError, JSON.stringify(schema));
    }
  });

  it("checks type, integer, enum, const, lengths in code points, bounds, required and additionalProperties", () => {
    const check = compileSchema({
      type: "object",
      additionalProperties: false,
      required: ["n", "s"],
      properties: {
        n: { type: "integer", minimum: 1, maximum: 3 },
        s: { type: "string", minLength: 2, maxLength: 3 },
        e: { enum: ["a", 1, null] },
        c: { const: { x: [1] } },
        a: { type: "array", minItems: 1, maxItems: 2, items: { type: ["string", "null"] } },
      },
    });
    assert.deepEqual(check({ n: 2, s: "ab" }), []);
    assert.deepEqual(check({ n: 2, s: "😀😀" }), [], "two code points");
    assert.equal(check({ n: 1.5, s: "ab" }).length, 1);
    assert.equal(check({ n: 4, s: "ab" }).length, 1);
    assert.equal(check({ n: 2, s: "abcd" }).length, 1);
    assert.equal(check({ n: 2, s: "ab", e: "b" }).length, 1);
    assert.equal(check({ n: 2, s: "ab", e: null }).length, 0);
    assert.equal(check({ n: 2, s: "ab", c: { x: [1] } }).length, 0);
    assert.equal(check({ n: 2, s: "ab", c: { x: [2] } }).length, 1);
    assert.equal(check({ n: 2, s: "ab", a: [] }).length, 1);
    assert.equal(check({ n: 2, s: "ab", a: ["x", null] }).length, 0);
    assert.equal(check({ n: 2, s: "ab", a: [1] }).length, 1);
    assert.deepEqual(check({ s: "ab", z: 1 }).map((error) => error.path).sort(), ["", "/z"]);
    assert.equal(check(Number.NaN).length, 1);
  });

  it("compiles every committed schema", () => {
    for (const schema of Object.values(PROCEDURE.schemas)) compileSchema(schema);
  });
});
