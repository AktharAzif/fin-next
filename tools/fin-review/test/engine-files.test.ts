// Rules on this part's files: the fake runner is reachable from tests only (T-RV-43's clause), and
// nothing committed under tools/fin-review or docs/review holds a local path or a non-example email
// (the public-repository rules).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { TOOL_ROOT } from "./helpers/cli.ts";

const DOCS = join(TOOL_ROOT, "..", "..", "docs", "review");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out.sort();
}

describe("this part's files", () => {
  it("delivers the runner, the review modes and the doctor", () => {
    const names = files(join(TOOL_ROOT, "src")).map((file) => relative(join(TOOL_ROOT, "src"), file));
    for (const expected of [
      "runner/types.ts",
      "runner/cli.ts",
      "runner/check.ts",
      "runner/settings.ts",
      "runner/env.ts",
      "runner/fake.ts",
      "review/run.ts",
      "review/findings.ts",
      "review/verdicts.ts",
      "doctor.ts",
    ]) {
      assert.ok(names.includes(expected), expected);
    }
  });

  it("imports the fake runner from no engine source", () => {
    for (const file of files(join(TOOL_ROOT, "src"))) {
      if (file.endsWith("fake.ts")) continue;
      assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+["'][^"']*fake\.ts["']/, relative(TOOL_ROOT, file));
    }
  });

  it("commits no local path and no email address outside example.com", () => {
    const committed = [...files(join(TOOL_ROOT, "src")), ...files(join(TOOL_ROOT, "config")), ...files(join(TOOL_ROOT, "test")), ...files(DOCS), join(TOOL_ROOT, "README.md")];
    for (const file of committed) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /\/Users\/[a-z]/, relative(TOOL_ROOT, file));
      for (const match of text.matchAll(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
        if (match[1] === "git") continue; // an ssh remote (git@host:owner/repo), not an address
        assert.ok(match[2] === "example.com" || match[2]?.endsWith(".example.com"), `${relative(TOOL_ROOT, file)}: ${match[0]}`);
      }
    }
  });
});
