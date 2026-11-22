import assert from "node:assert/strict";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readCredential } from "../src/core/credentials.ts";
import { ConfigError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { fakeToken, tempDir, writePrivate } from "./helpers/fixtures.ts";

describe("readCredential", () => {
  it("reads a private one-line file into a Secret and masks the value", () => {
    const dir = tempDir();
    const token = fakeToken("cf");
    const path = writePrivate(dir, "token", `${token}\n`);
    const m = new Masker();
    const secret = readCredential({ FIN_CF_TOKEN_FILE: path }, "FIN_CF_TOKEN_FILE", m);
    assert.equal(secret.reveal(), token);
    assert.equal(m.mask(`Bearer ${token}`), "Bearer <fin_cf_token>");
  });

  it("refuses an unset variable, naming the variable", () => {
    assert.throws(
      () => readCredential({}, "FIN_RAILWAY_TOKEN_FILE", new Masker()),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, /FIN_RAILWAY_TOKEN_FILE is not set/);
        return true;
      },
    );
  });

  it("refuses a missing file, a link, a group-readable file, an empty file and two lines", () => {
    const dir = tempDir();
    const m = new Masker();
    const env = (path: string) => ({ FIN_CF_TOKEN_FILE: path });
    assert.throws(
      () => readCredential(env(join(dir, "none")), "FIN_CF_TOKEN_FILE", m),
      /does not exist/,
    );

    const real = writePrivate(dir, "real", fakeToken("a"));
    const link = join(dir, "link");
    symlinkSync(real, link);
    assert.throws(() => readCredential(env(link), "FIN_CF_TOKEN_FILE", m), /regular file/);

    const open = join(dir, "open");
    writeFileSync(open, fakeToken("b"));
    chmodSync(open, 0o644);
    assert.throws(() => readCredential(env(open), "FIN_CF_TOKEN_FILE", m), /others can read/);

    const empty = writePrivate(dir, "empty", "\n");
    assert.throws(() => readCredential(env(empty), "FIN_CF_TOKEN_FILE", m), /empty/);

    const two = writePrivate(dir, "two", `${fakeToken("c")}\nsecond`);
    assert.throws(() => readCredential(env(two), "FIN_CF_TOKEN_FILE", m), /second line/);
  });

  it("never puts the file's content in an error", () => {
    const dir = tempDir();
    const value = `${fakeToken("d")} with-space`;
    const path = writePrivate(dir, "bad", value);
    try {
      readCredential({ FIN_CF_TOKEN_FILE: path }, "FIN_CF_TOKEN_FILE", new Masker());
      assert.fail("should refuse");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(fakeToken("d")), false);
    }
  });
});
