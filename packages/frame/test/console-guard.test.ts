// The scrubbing console guard (spec 06 §2.3 step 1, FW-C15's browser twin): nothing the page logs
// prints an Error whole, or an address, a token, a code or a query string, however the call splits
// it across a format string and its arguments.
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { ApiError } from "../src/api/errors.ts";
import {
  CUT_MARK,
  installConsoleGuard,
  LINE_LIMIT,
  safeConsoleValue,
} from "../src/report/console-guard.ts";

// A fake address and secrets, built at run time so the repository's public-safety scan never sees
// a real-looking literal.
const ADDRESS = ["maya.rivera", "example.com"].join("@");
const TOKEN = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c3JfMSJ9", "c2lnbmF0dXJl"].join(".");
const API_KEY = ["fin", "live", "sk", "0123456789ABCDEFGHIJabcdefghij0123456789abcdefgh"].join("_");
// An opaque bearer value: no shape of its own, only the word before it says what it is.
const OPAQUE = ["k7Qm", "2Xw9", "Lp4Z", "t8Rb", "N3vY", "q6Hd", "s1Fj", "c5Ug"].join("");
const DASHES = "-".repeat(5);

type Recorded = unknown[];

/** A console that records what reaches it, after the guard. */
function recordingConsole() {
  const lines: Recorded[] = [];
  const contexts: { lines: Recorded[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      lines.push([method, ...args]);
  const target: Record<string, unknown> = {
    assert: (condition: unknown, ...args: unknown[]) => lines.push(["assert", condition, ...args]),
    context: () => {
      const inner = recordingConsole();
      contexts.push(inner);
      return inner.target;
    },
  };
  for (const method of [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "dir",
    "dirxml",
    "table",
    "group",
    "groupCollapsed",
    "groupEnd",
    "count",
    "countReset",
    "time",
    "timeLog",
    "timeEnd",
  ]) {
    target[method] = record(method);
  }
  return { target: target as unknown as Console, lines, contexts };
}

const printed = (lines: readonly Recorded[]) => JSON.stringify(lines);

/**
 * What the browser prints for each recorded line printing call: one string it can read no
 * directive in, either alone with no `%` in it or as the argument of a lone `%s`.
 */
function printedText(line: Recorded): string {
  const [, ...args] = line;
  if (args.length === 1 && typeof args[0] === "string" && !args[0].includes("%")) return args[0];
  if (args.length === 2 && args[0] === "%s" && typeof args[1] === "string") return args[1];
  throw new Error(`not one string the browser prints as it is: ${JSON.stringify(line)}`);
}

describe("the console guard", () => {
  it("never prints an Error whole: its name and code stay, its message and stack do not", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    const error = Object.assign(new TypeError(`no account for ${ADDRESS}`), { code: "not_found" });
    target.error(error);
    target.warn("Warning:", error);
    target.log(new Error(`token ${TOKEN}`));
    target.error("%s", error);
    remove();
    expect(printed(lines)).not.toContain(ADDRESS);
    expect(printed(lines)).not.toContain(TOKEN);
    expect(printed(lines)).not.toContain("at ");
    expect(lines).toEqual([
      ["error", "TypeError [not_found]"],
      ["warn", "Warning: TypeError [not_found]"],
      ["log", "Error"],
      ["error", "TypeError [not_found]"],
    ]);
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
    target.table([{ email: ADDRESS }], ["email"]);
    target.dir({ nested: { error: new Error(ADDRESS) } }, { depth: 3 });
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
    expect(lines).toEqual([
      ["info", "signed in as [email] with [api-key]"],
      ["debug", "GET /api/invitation?[query] failed [Object] [Array]"],
      ["error", "Bearer [secret] rejected [cookie]; Path=/"],
      // A table's columns and dir's options are never printed: only the value, reduced.
      ["table", "[Array]"],
      ["dir", "[Object]"],
      ["assert", false, "assertion about [email]"],
      ["trace", "[email]"],
      ["group", "[email]"],
      ["groupCollapsed", "[email]"],
      ["dirxml", "[email]"],
    ]);
  });

  it("scrubs the codes, digit runs and IPv6 addresses people type (spec 08 §5.4)", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    for (const text of [
      "code: 123456",
      "otp=12345678",
      "account 123456789012",
      "phone 447700900123",
      "client 2001:db8:85a3::8a2e:370:7334",
      "ip 2001:db8::1",
    ]) {
      target.log(text);
    }
    remove();
    expect(lines.map(printedText)).toEqual([
      "code [code]",
      "otp [code]",
      "account [digits]",
      "phone [digits]",
      "client [ip]",
      "ip [ip]",
    ]);
  });

  it("applies a format string before it scrubs, so a shape split by directives is found whole", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    const [name, domain] = ADDRESS.split("@");
    target.error("%s@%s", name, domain);
    target.log("GET %s?%s", "/api/invitation", `token=${OPAQUE}`);
    target.info("%s: %d", "account", 123456789012);
    target.warn("%c%s %d %i %f %o %O", "color: red", "x", 42.9, "7px", "1.5", { email: ADDRESS }, [
      ADDRESS,
    ]);
    // A directive with no argument left stays as it is; `%%` is a percent sign.
    target.info("%s and %s", "one");
    target.log("%d%% done", 50);
    // A value is never read as a format: its directive stays text, and so does the browser's.
    target.log("%s", `${name}%s`, `@${domain}`);
    remove();
    expect(printed(lines)).not.toContain(ADDRESS);
    expect(printed(lines)).not.toContain(OPAQUE);
    expect(lines.map(printedText)).toEqual([
      "[email]",
      "GET /api/invitation?[query]",
      "account: [digits]",
      "x 42 7 1.5 [Object] [Array]",
      "one and %s",
      "50% done",
      `${name}%s @${domain}`,
    ]);
  });

  it("joins the arguments as the browser does before it scrubs, so a shape split across them is found", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    target.info("Authorization: Bearer", OPAQUE);
    target.log(
      `${DASHES}BEGIN PRIVATE KEY${DASHES}`,
      "MIIEvQIBADANBgkqhkiG9w0B",
      `${DASHES}END`,
      `PRIVATE KEY${DASHES}`,
    );
    target.log("account", 123456789012, "ok", true, null, undefined, 10n);
    target.log();
    remove();
    expect(printed(lines)).not.toContain(OPAQUE);
    expect(printed(lines)).not.toContain("MIIEvQIBADANBgkqhkiG9w0B");
    expect(lines).toEqual([
      ["info", "Authorization: Bearer [secret]"],
      ["log", "[private-key]"],
      ["log", "account [digits] ok true null undefined 10n"],
      ["log"],
    ]);
  });

  it("scrubs a long bigint and a number in exponent form, whose digits the digits row cannot see", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    const big = 1234567890123456n;
    // 1e21 and more prints in exponent form, keeping 17 digits beside its `e`.
    const huge = Number("12345678901234567890123");
    target.log(big);
    target.log("acct %d", big);
    target.log("acct %i %f %s %o", big, big, big, big);
    target.log(huge);
    target.log("%d", "12345678901234567890123");
    target.log("%f", "1.2345678901234567e-10");
    target.log("%i", huge);
    target.log("acct", -9876543210987654321n, huge);
    // Short ones print as they are; a run of nine digits or more is left to the line's row.
    target.log(10n, 1e21, 1.5e-7, 123456789);
    // A label is whatever a library passes, typed or not.
    const labels = target as unknown as Record<"count" | "time", (label: unknown) => void>;
    labels.count(big);
    labels.time(huge);
    remove();
    expect(printed(lines)).not.toMatch(/\d{9,}/u);
    expect(lines.slice(0, -2).map(printedText)).toEqual([
      "[digits]n",
      "acct [digits]n",
      "acct [digits]n [digits]n [digits]n [digits]n",
      "[digits]",
      "[digits]",
      "[digits]",
      "[digits]",
      "acct -[digits]n [digits]",
      "10n 1e+21 1.5e-7 [digits]",
    ]);
    expect(lines.slice(-2)).toEqual([
      ["count", "[digits]n"],
      ["time", "[digits]"],
    ]);
    expect(safeConsoleValue(big)).toBe("[digits]n");
    expect(safeConsoleValue(huge)).toBe("[digits]");
  });

  it("cuts a line longer than LINE_LIMIT at a space, so no value is left cut in two", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    // An address runs across the limit: the cut takes it whole, never leaving its start to print.
    const filler = "x ".repeat(Math.floor((LINE_LIMIT - 5) / 2));
    target.log(`${filler}${ADDRESS} and more`);
    // One run with no space in it: nothing of it is left but the mark.
    target.error("%s", "a".repeat(LINE_LIMIT * 4));
    target.warn(`${"y".repeat(LINE_LIMIT - 1)} z`);
    target.info("short line");
    remove();
    const [cut, run, edge, short] = lines.map(printedText);
    expect(cut).toBe(`${filler.trimEnd()} ${CUT_MARK}`);
    expect(cut).not.toContain(ADDRESS.slice(0, 4));
    expect(run).toBe(CUT_MARK);
    expect(edge).toBe(`${"y".repeat(LINE_LIMIT - 1)} ${CUT_MARK}`);
    expect(short).toBe("short line");
    for (const line of [cut, run, edge]) {
      expect(line?.length).toBeLessThanOrEqual(LINE_LIMIT + CUT_MARK.length + 1);
    }
  });

  it("spends bounded time on one huge line, whatever it holds", () => {
    const { target } = recordingConsole();
    const remove = installConsoleGuard(target);
    const started = performance.now();
    target.log(`${"__Host-a ".repeat(8 * 1024)}${"__Host-a".repeat(64 * 1024)}`);
    target.log("%s", `postgres://a:${"b ".repeat(128 * 1024)}`);
    remove();
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("scrubs a counter's or a timer's label, and a timer's data as one line", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    target.time(ADDRESS);
    target.timeLog(ADDRESS, "for", ADDRESS, { email: ADDRESS });
    target.timeEnd(ADDRESS);
    target.count(ADDRESS);
    target.countReset(ADDRESS);
    target.count();
    // A `%` in a label is never a directive the timer's data could fill: it shows as U+FF05.
    target.timeLog("load%s", `@${ADDRESS.split("@")[1]}`);
    remove();
    expect(printed(lines)).not.toContain(ADDRESS);
    expect(lines).toEqual([
      ["time", "[email]"],
      ["timeLog", "[email]", "for [email] [Object]"],
      ["timeEnd", "[email]"],
      ["count", "[email]"],
      ["countReset", "[email]"],
      ["count", undefined],
      ["timeLog", `load${String.fromCharCode(0xff05)}s`, "@example.com"],
    ]);
  });

  it("asserts with the condition as it is, and prints nothing it builds when it holds", () => {
    const { target, lines } = recordingConsole();
    const remove = installConsoleGuard(target);
    const [name, domain] = ADDRESS.split("@");
    target.assert(false, "%s@%s", name, domain);
    target.assert(true, ADDRESS);
    target.assert(false);
    remove();
    expect(lines).toEqual([
      ["assert", false, "[email]"],
      ["assert", true],
      ["assert", false],
    ]);
  });

  it("guards a console context the console makes (Chromium's console.context)", () => {
    const { target, contexts } = recordingConsole();
    const remove = installConsoleGuard(target);
    const context = (target as unknown as { context: (name: string) => Console }).context(ADDRESS);
    context.error("for %s", ADDRESS);
    remove();
    expect(contexts.map((inner) => inner.lines)).toEqual([[["error", "for [email]"]]]);
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
    const originalTime = target.time;
    const remove = installConsoleGuard(target);
    const again = installConsoleGuard(target);
    target.error(new Error(ADDRESS));
    again();
    target.error(new Error(ADDRESS));
    remove();
    expect(target.error).toBe(original);
    expect(target.time).toBe(originalTime);
    target.error("after");
    expect(printed(lines.slice(0, 2))).not.toContain(ADDRESS);
    expect(lines[2]).toEqual(["error", "after"]);
  });

  it("is what @fin/frame/report installs, a side effect bundlers keep", () => {
    expect(packageJson.exports["./report"]).toBe("./src/report/index.ts");
    expect(packageJson.sideEffects).toContain("./src/report/index.ts");
  });
});
