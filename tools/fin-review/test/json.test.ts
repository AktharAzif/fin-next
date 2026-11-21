// The strict JSON parser that every configuration, manifest and layout read goes through.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonBytes, parseJsonStrict } from "../src/json.ts";

describe("parseJsonStrict", () => {
  it("parses what JSON.parse parses, to the same value", () => {
    for (const text of [
      "null",
      "true",
      "false",
      "0",
      "-0.5e+3",
      "1E2",
      '"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00"',
      "[]",
      "{}",
      ' { "a" : [ 1 , { "b" : null } ] , "c" : "x" } ',
      '{"__proto__": {"x": 1}, "constructor": 2, "prototype": 3}',
    ]) {
      const result = parseJsonStrict(text);
      assert.equal(result.ok, true, text);
      if (result.ok) assert.deepEqual(JSON.parse(JSON.stringify(result.value)), JSON.parse(text), text);
    }
  });

  it("returns null-prototype objects, so __proto__ is an own key and pollutes nothing", () => {
    const result = parseJsonStrict('{"__proto__": {"polluted": true}}');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const value = result.value as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(value), null);
    assert.deepEqual(Object.keys(value), ["__proto__"]);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("refuses a repeated key, and says where", () => {
    const result = parseJsonStrict('{"a": {"model": "opus", "model": "fable"}}');
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.duplicateKey, { path: "$.a", key: "model" });
  });

  it("refuses what JSON refuses, and a byte order mark", () => {
    for (const text of [
      "",
      " ",
      "{",
      "[1,]",
      '{"a":1,}',
      "{a:1}",
      "'a'",
      "01",
      "1.",
      ".5",
      "+1",
      "NaN",
      "Infinity",
      "1e400",
      '"\u0001"',
      '"\\x41"',
      '"\\u12"',
      "nul",
      "truex",
      "1 2",
      '{"a" 1}',
      "﻿{}",
      '"unterminated',
    ]) {
      assert.equal(parseJsonStrict(text).ok, false, JSON.stringify(text));
    }
  });

  it("caps nesting depth", () => {
    assert.equal(parseJsonStrict(`${"[".repeat(64)}${"]".repeat(64)}`).ok, true);
    assert.equal(parseJsonStrict(`${"[".repeat(65)}${"]".repeat(65)}`).ok, false);
    assert.equal(parseJsonStrict(`${"[".repeat(100000)}`).ok, false);
  });

  it("parseJsonBytes refuses invalid UTF-8", () => {
    assert.equal(parseJsonBytes(Buffer.from([0x22, 0xff, 0x22])).ok, false);
    assert.equal(parseJsonBytes(Buffer.from('"é"', "utf8")).ok, true);
  });
});
