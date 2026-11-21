import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { processRuntime } from "../src/core/runtime.ts";
import { tempDir } from "./helpers/fixtures.ts";

describe("the process runtime", () => {
  it("reports the commit and whether the checkout has local changes", () => {
    const dir = tempDir();
    execFileSync("git", ["init", "-q", dir]);
    const runtime = processRuntime(dir);
    assert.equal(runtime.commit(), undefined, "no commit yet");
    assert.equal(runtime.dirty(), false);
    writeFileSync(join(dir, "file.txt"), "x");
    assert.equal(runtime.dirty(), true);
    assert.equal(processRuntime(tempDir()).dirty(), undefined, "not a checkout");
  });
});
