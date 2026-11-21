import { describe, expect, it, vi } from "vitest";
import { captureLinkToken, takeLinkToken } from "./link-token.ts";

// A token-shaped value, built at run time (the public-safety scan never sees a literal one).
const TOKEN = ["0123456789ABCDEF", "GHJKMNPQRSTVWXYZ"].join("");

function run(pathname: string, hash: string) {
  const replaceState = vi.fn();
  const token = captureLinkToken({ pathname, hash }, { replaceState });
  return { token, replaceState };
}

describe("the link token in the fragment (FW-C21)", () => {
  it("takes the token and clears it from the address bar and the history", () => {
    const { token, replaceState } = run("/c", `#${TOKEN}`);
    expect(token).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/c");
  });

  it("accepts each link path, with a trailing slash, in either case", () => {
    expect(run("/p/", `#${TOKEN.toLowerCase()}`).token).toBe(TOKEN);
    expect(run("/a", `#${TOKEN}`).token).toBe(TOKEN);
  });

  it("clears any fragment but keeps nothing that is not a token on a link path", () => {
    for (const [path, hash] of [
      ["/c", "#short"],
      ["/c", `#${TOKEN}X`],
      ["/c", `#${TOKEN.slice(0, 31)}I`],
      ["/elsewhere", `#${TOKEN}`],
    ] as const) {
      const { token, replaceState } = run(path, hash);
      expect(token).toBeNull();
      expect(replaceState).toHaveBeenCalledWith(null, "", path);
    }
  });

  it("leaves a page with no fragment alone", () => {
    const { token, replaceState } = run("/c", "");
    expect(token).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("hands the captured token over once", () => {
    // No window in unit tests, so nothing was captured as the module loaded.
    expect(takeLinkToken()).toBeNull();
  });
});
