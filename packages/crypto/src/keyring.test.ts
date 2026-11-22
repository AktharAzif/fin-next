import { describe, expect, it } from "vitest";
import { toBase64Url } from "./bytes.ts";
import { createKeyring, KeyringConfigError, keyringFromEnv } from "./keyring.ts";

const key = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));

function errorOf(fn: () => unknown): KeyringConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof KeyringConfigError) return error;
    throw error;
  }
  throw new Error("expected a KeyringConfigError");
}

describe("keyringFromEnv", () => {
  it("reads every version present and the IN_USE one", () => {
    const ring = keyringFromEnv(
      { FIN_SEAL_KEY_1: key(1), FIN_SEAL_KEY_2: key(2), FIN_SEAL_KEY_IN_USE: "2", OTHER: "x" },
      "FIN_SEAL_KEY",
    );
    expect(ring.inUse).toBe(2);
    expect(ring.versions).toEqual([1, 2]);
    expect(ring.writeVersions).toEqual([2]);
    expect(ring.key(1)).toEqual(new Uint8Array(32).fill(1));
    expect(ring.key(3)).toBeUndefined();
  });

  it("refuses an IN_USE naming an absent version, naming the variable and never the value", () => {
    const error = errorOf(() =>
      keyringFromEnv({ FIN_SEAL_KEY_1: key(9), FIN_SEAL_KEY_IN_USE: "2" }, "FIN_SEAL_KEY"),
    );
    expect(error.variable).toBe("FIN_SEAL_KEY_IN_USE");
    expect(error.message).not.toContain(key(9));
  });

  it("refuses a missing IN_USE, a malformed or short key and more than three versions", () => {
    expect(errorOf(() => keyringFromEnv({ FIN_SEAL_KEY_1: key(1) }, "FIN_SEAL_KEY")).variable).toBe(
      "FIN_SEAL_KEY_IN_USE",
    );
    const short = errorOf(() =>
      keyringFromEnv(
        { FIN_SEAL_KEY_1: toBase64Url(new Uint8Array(16)), FIN_SEAL_KEY_IN_USE: "1" },
        "FIN_SEAL_KEY",
      ),
    );
    expect(short.variable).toBe("FIN_SEAL_KEY_1");
    expect(
      errorOf(() =>
        keyringFromEnv({ FIN_SEAL_KEY_1: "not base64!", FIN_SEAL_KEY_IN_USE: "1" }, "FIN_SEAL_KEY"),
      ).variable,
    ).toBe("FIN_SEAL_KEY_1");
    expect(() =>
      keyringFromEnv(
        {
          FIN_SEAL_KEY_1: key(1),
          FIN_SEAL_KEY_2: key(2),
          FIN_SEAL_KEY_3: key(3),
          FIN_SEAL_KEY_4: key(4),
          FIN_SEAL_KEY_IN_USE: "4",
        },
        "FIN_SEAL_KEY",
      ),
    ).toThrow(KeyringConfigError);
    expect(
      errorOf(() =>
        keyringFromEnv({ FIN_SEAL_KEY_1: key(1), FIN_SEAL_KEY_IN_USE: "01" }, "FIN_SEAL_KEY"),
      ).variable,
    ).toBe("FIN_SEAL_KEY_IN_USE");
  });

  it("reads WRITE for index families only, and requires it to include IN_USE", () => {
    const ring = keyringFromEnv(
      {
        FIN_INDEX_KEY_1: key(1),
        FIN_INDEX_KEY_2: key(2),
        FIN_INDEX_KEY_IN_USE: "1",
        FIN_INDEX_KEY_WRITE: "1,2",
      },
      "FIN_INDEX_KEY",
    );
    expect(ring.writeVersions).toEqual([1, 2]);
    expect(
      errorOf(() =>
        keyringFromEnv(
          { FIN_SEAL_KEY_1: key(1), FIN_SEAL_KEY_IN_USE: "1", FIN_SEAL_KEY_WRITE: "1" },
          "FIN_SEAL_KEY",
        ),
      ).variable,
    ).toBe("FIN_SEAL_KEY_WRITE");
    expect(
      errorOf(() =>
        keyringFromEnv(
          {
            FIN_INDEX_KEY_1: key(1),
            FIN_INDEX_KEY_2: key(2),
            FIN_INDEX_KEY_IN_USE: "1",
            FIN_INDEX_KEY_WRITE: "2",
          },
          "FIN_INDEX_KEY",
        ),
      ).variable,
    ).toBe("FIN_INDEX_KEY_WRITE");
  });

  it("copies keys, so a caller cannot change a keyring after building it", () => {
    const raw = new Uint8Array(32).fill(5);
    const ring = createKeyring("FIN_LIMIT_KEY", new Map([[1, raw]]), 1);
    raw.fill(0);
    expect(ring.key(1)).toEqual(new Uint8Array(32).fill(5));
  });
});
