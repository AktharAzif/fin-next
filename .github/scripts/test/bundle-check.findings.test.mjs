// Every reproduction from bundle-check's review rounds, read from bundle-check.findings.txt: one
// test per finding, named after it, each reproduction with the outcome its finding and the
// steward's ruling give it (caught, or not a finding), and each case of the scan's work under its
// counted bound. The fixture's header gives its format. A reproduction is checked as a file of a
// static build (checkStatic), alone in its own folder.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkStatic, scanWork } from "../bundle-check.mjs";
import { tempDir, writeTree } from "./helpers.mjs";

const FIXTURE = new URL("./bundle-check.findings.txt", import.meta.url);
/**
 * The findings the fixture holds: the 136 of the review rounds' journals, the 23 of the
 * steward's two lists of open findings (5 and 18), and the 5 of the tokenizer port's review that
 * a static build reproduces (BC1.2 to BC1.6), each once.
 */
const FINDINGS = 164;
/** The scanner's bound on its work, per character of a text (bundle-check.test.mjs's). */
const WORK_PER_CHARACTER = 64;
/** Only a hang, never load, comes near it: the work's bound is counted, not timed. */
const HANG = { timeout: 600_000 };
/** The rules by which a URL is refused. */
const URL_RULES = new Set(["third-party-origin", "url-userinfo", "url-unread", "url-unparsed"]);

/**
 * A fixture text with its placeholders read: ⟨NL⟩, ⟨U+XXXX⟩ and ⟨N×S⟩, innermost first.
 * @param {string} text
 */
function expand(text) {
  let out = text;
  const inner = /⟨([^⟨⟩]*)⟩/;
  for (let m = inner.exec(out); m !== null; m = inner.exec(out)) {
    const body = m[1] ?? "";
    const repeat = /^(\d+)×([\s\S]*)$/.exec(body);
    let value = "";
    if (body === "NL") value = "\n";
    else if (/^U\+[0-9A-F]{4,6}$/.test(body)) {
      value = String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    } else if (repeat !== null) value = (repeat[2] ?? "").repeat(Number(repeat[1]));
    else throw new Error(`the fixture holds an unknown placeholder: ⟨${body}⟩`);
    out = out.slice(0, m.index) + value + out.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * @typedef {{ mark: string, where: string, expect: string[], text: string, line: string }} Case
 * @typedef {{ id: string, cls: string, title: string, notes: string[], cases: Case[] }} Block
 */

/**
 * The fixture's findings, each with its reproductions.
 * @param {string} text
 * @returns {Block[]}
 */
function parse(text) {
  /** @type {Block[]} */
  const blocks = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    if (line.startsWith("== ")) {
      const [id = "", cls = "", ...title] = line.slice(3).split(" | ");
      blocks.push({ id, cls, title: title.join(" | "), notes: [], cases: [] });
      continue;
    }
    const block = blocks.at(-1);
    assert.ok(block !== undefined, `a line before the fixture's first finding: ${line}`);
    if (line.startsWith("> ")) {
      block.notes.push(line.slice(2));
      continue;
    }
    const sep = line.indexOf(" | ");
    assert.ok(sep > 0, `a line with no " | ": ${line}`);
    const [mark = "", where = "", ...expect] = line.slice(0, sep).split(" ");
    assert.ok(["+", "-", "~"].includes(mark), `a line of no known kind: ${line}`);
    block.cases.push({ mark, where, expect, text: expand(line.slice(sep + 3)), line });
  }
  return blocks;
}

/** @param {string} value */
const isOrigin = (value) => /^(?:https?|wss?):\/\//.test(value);

/**
 * Checks one reproduction.
 * @param {import("node:test").TestContext} t
 * @param {Block} block
 * @param {Case} c
 */
function check(t, block, c) {
  const why = [`${block.id}: ${c.line.slice(0, 200)}`, ...block.notes].join("\n  ");
  if (c.mark === "~") {
    const { urls } = scanWork(c.text, {
      kind: c.where,
      limit: WORK_PER_CHARACTER * c.text.length,
    });
    const origins = [...new Set(urls.flatMap((u) => (u.origin === null ? [] : [u.origin])))];
    const want = c.expect[0] ?? "";
    if (want !== "any") {
      assert.deepEqual(origins.sort(), want === "none" ? [] : want.split(",").sort(), why);
    }
    return;
  }
  const dir = tempDir(t);
  writeTree(dir, { [c.where]: c.text });
  const findings = checkStatic("x", dir);
  if (c.mark === "-") {
    assert.deepEqual(
      findings.map((f) => `${f.rule}: ${f.message}`),
      [],
      why,
    );
    return;
  }
  const rules = findings.map((f) => f.rule);
  const origins = findings.flatMap((f) =>
    f.rule === "third-party-origin" ? [f.message.replace(/^names /, "")] : [],
  );
  const wantRules = c.expect.filter((e) => !isOrigin(e));
  if (wantRules.length === 0) {
    assert.ok(
      rules.some((r) => URL_RULES.has(r)),
      `${why}\n  refused by no URL rule: ${rules.join()}`,
    );
  }
  for (const rule of wantRules) {
    assert.ok(
      rules.some((r) => r === rule),
      `${why}\n  no ${rule}: ${rules.join()}`,
    );
  }
  // Each origin compared whole, never as a substring of a URL.
  for (const origin of c.expect.filter(isOrigin)) {
    assert.ok(
      origins.some((o) => o === origin),
      `${why}\n  ${origin} not among ${origins.join(" ")}`,
    );
  }
}

const blocks = parse(readFileSync(FIXTURE, "utf8"));

describe("bundle-check against every reproduction of its review rounds", () => {
  it("the fixture holds every finding once, each with a reproduction and a class", () => {
    assert.equal(blocks.length, FINDINGS);
    assert.equal(new Set(blocks.map((b) => b.id)).size, FINDINGS);
    for (const block of blocks) {
      assert.ok(block.cases.length > 0, `${block.id} holds no reproduction`);
      assert.ok(["A", "B", "C", "W", "R"].includes(block.cls), `${block.id}'s class: ${block.cls}`);
    }
  });

  for (const block of blocks) {
    it(`${block.id}: ${block.title}`, HANG, (t) => {
      for (const c of block.cases) check(t, block, c);
    });
  }
});
