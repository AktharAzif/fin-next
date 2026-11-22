// The scrubbing console guard (spec 06 §2.3 step 1, FW-C15's browser twin): nothing the page logs
// prints an Error whole, or an address, a token or a query string.
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { ApiError } from "../src/api/errors.ts";
import { installConsoleGuard, safeConsoleValue } from "../src/report/console-guard.ts";

// A fake address and secrets, built at run time so the repository's public-safety scan never sees
// a real-looking literal.
const ADDRESS = ["maya.rivera", "example.com"].join("@");
const TOKEN = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c3JfMSJ9", "c2lnbmF0dXJl"].join(".");
const API_KEY = ["fin", "live", "sk", "0123456789ABCDEFGHIJabcdefghij0123456789abcdefgh"].join("_");

/** A console that records what reaches it, after the guard. */
function recordingConsole() {
  const lines: unknown[][] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      lines.push([method, ...args]);
  const target = {
    log: record("log"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    trace: record("trace"),
    dir: record("dir"),
    dirxml: record("dirxml"),
    table: record("table"),
    group: record("group"),
    groupCollapsed: record("groupCollapsed"),
    groupEnd: record("groupEnd"),
    assert: (condition: unknown, ...args: unknown[]) => lines.push(["assert", condition, ...args]),
  };
  return { target: target as unknown as Console, lines };
}

const printed = (lines: unknown[][]) => JSON.stringify(lines);

describe("the console guard", () => {
  it("never prints an Error whole: its name and code stay, its message and stack do not", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    const error = Object.assign(new TypeError(`no account for ${ADDRESS}`), { code: "not_found" });
    target.error(error);
    target.warn("Warning:", error);
    target.log(new Error(`token ${TOKEN}`));
    remove();
    expect(printed(lines)).not.toContain(ADDRESS);
    expect(printed(lines)).not.toContain(TOKEN);
    expect(printed(lines)).not.toContain("at ");
    expect(lines[0]).toEqual(["error", "TypeError [not_found]"]);
    expect(lines[1]).toEqual(["warn", "Warning:", "TypeError [not_found]"]);
    expect(lines[2]).toEqual(["log", "Error"]);
  });

  it("keeps the frame's own ApiError message, which names a contract and codes only", () => {
    const error = new ApiError({
      kind: "problem",
      contract: "team.invite",
      status: 403,
      problem: { type: "about:blank", title: "x", status: 403, code: "step_up_required" },
    });
    expect(safeConsoleValue(error)).toBe("ApiError: team.invite: problem 403 step_up_required");
  });

  it("scrubs the strings it prints and never prints an object's contents", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    target.info(`signed in as ${ADDRESS} with ${API_KEY}`);
    target.debug(`GET /api/invitation?token=${TOKEN} failed`, { email: ADDRESS }, [ADDRESS]);
    target.error("Bearer abcdefghijklmnop rejected", "__Host-fin_session=abc123def456; Path=/");
    target.table([{ email: ADDRESS }]);
    target.dir({ nested: { error: new Error(ADDRESS) } });
    target.assert(false, `assertion about ${ADDRESS}`);
    target.trace(ADDRESS);
    target.group(ADDRESS);
    target.groupCollapsed(ADDRESS);
    target.dirxml(ADDRESS);
    remove();
    const text = printed(lines);
    for (const secret of [ADDRESS, TOKEN, API_KEY, "abcdefghijklmnop", "abc123def456"]) {
      expect(text).not.toContain(secret);
    }
    expect(lines[0]).toEqual(["info", "signed in as [email] with [api-key]"]);
    expect(lines[1]).toEqual([
      "debug",
      "GET /api/invitation?[query] failed",
      "[Object]",
      "[Array]",
    ]);
    expect(lines[5]).toEqual(["assert", false, "assertion about [email]"]);
  });

  it("prints numbers, booleans, null and undefined as they are", () => {
    for (const value of [0, 42.5, true, false, null, undefined, 10n]) {
      expect(safeConsoleValue(value)).toBe(value);
    }
    expect(safeConsoleValue(Symbol("x"))).toBe("[symbol]");
    expect(safeConsoleValue(() => ADDRESS)).toBe("[function]");
  });

  it("is installed once per console, and removing it gives the console back", () => {
    const { target, lines } = recordingConsole();
    const original = target.error;
    const remove = installConsoleGuard(target);
    const again = installConsoleGuard(target);
    target.error(new Error(ADDRESS));
    again();
    target.error(new Error(ADDRESS));
    remove();
    expect(target.error).toBe(original);
    target.error("after");
    expect(printed(lines.slice(0, 2))).not.toContain(ADDRESS);
    expect(lines[2]).toEqual(["error", "after"]);
  });

  it("is what @fin/frame/report installs, a side effect bundlers keep", () => {
    expect(packageJson.exports["./report"]).toBe("./src/report/index.ts");
    expect(packageJson.sideEffects).toContain("./src/report/index.ts");
  });
});
