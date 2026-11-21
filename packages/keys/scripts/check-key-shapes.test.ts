// T05-03: the check fails on a planted valid-checksum key under each known salt, in a temporary file
// named as a tracked one, and passes on the repository's tracked files.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { newKey } from "../src/generate.ts";
import { KNOWN_SALTS } from "../src/salts.ts";
import { checkFiles, findKeys, trackedFiles } from "./check-key-shapes.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "fin-key-shapes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("check-key-shapes", () => {
  it("finds a planted key under every known salt, with its line", () => {
    for (const salt of KNOWN_SALTS) {
      const key = newKey("live", "sk", salt).key;
      writeFileSync(join(dir, "planted.ts"), `// fixture\nconst k = "${key}";\n`);
      expect(checkFiles(dir, ["planted.ts"])).toEqual([{ file: "planted.ts", line: 2 }]);
    }
  });

  it("ignores a key shape whose checksum verifies under no known salt", () => {
    const key = newKey("test", "rk", "another-salt").key;
    expect(findKeys(key)).toEqual([]);
    expect(findKeys("fin_test_sk_... and $FIN_KEY")).toEqual([]);
  });

  it("passes on every file the repository tracks", () => {
    expect(checkFiles(REPO, trackedFiles(REPO))).toEqual([]);
  });
});
