import { describe, expect, it } from "vitest";
import { createManualClock, rfc3339, systemClock } from "./clock.ts";
import {
  ConfigError,
  EXIT_CONFIG,
  FinError,
  isBoundedCode,
  isFinError,
  Refusal,
  UnavailableError,
} from "./errors.ts";
import { safeError, safeException, stackFrameLines } from "./safe-error.ts";

describe("FinError and its kinds", () => {
  it("carries a bounded code, a status and frozen extensions", () => {
    const refusal = new Refusal("invalid_origin", 403, "The request's origin is refused", {
      extensions: { reason: "origin_missing" },
    });
    expect(refusal).toBeInstanceOf(FinError);
    expect(isFinError(refusal)).toBe(true);
    expect(refusal.status).toBe(403);
    expect(Object.isFrozen(refusal.extensions)).toBe(true);
    expect(new UnavailableError("access_unavailable", "Access keys are unavailable").status).toBe(
      503,
    );
  });

  it("refuses a code that is not bounded", () => {
    expect(() => new FinError("Free Text!", "x")).toThrow(TypeError);
    expect(isBoundedCode("origin_gate.app_header")).toBe(true);
    expect(isBoundedCode("a".repeat(65))).toBe(false);
    expect(isBoundedCode("1abc")).toBe(false);
  });

  it("names the variable of a configuration error, never a value", () => {
    const error = new ConfigError("FIN_PUBLIC_ORIGIN", "malformed");
    expect(error.message).toBe("FIN_PUBLIC_ORIGIN is malformed");
    expect(error.variable).toBe("FIN_PUBLIC_ORIGIN");
    expect(() => new ConfigError("not a name", "missing")).toThrow(TypeError);
    expect(EXIT_CONFIG).toBe(78);
  });
});

describe("safeError", () => {
  it("drops the message of an unexpected error and keeps its name and frames", () => {
    const error = new TypeError("could not parse someone@example.com");
    const safe = safeError(error);
    expect(safe.errorName).toBe("TypeError");
    expect(safe.errorCode).toBe("unexpected");
    expect(safe.message).toBeUndefined();
    expect(safe.frames.length).toBeGreaterThan(0);
    for (const frame of safe.frames) {
      expect(typeof frame.file).toBe("string");
      expect(frame.line).toBeGreaterThan(0);
    }
    expect(JSON.stringify(safe)).not.toContain("example.com");
  });

  it("keeps a FinError's code and fixed message", () => {
    const safe = safeError(new Refusal("invalid_origin", 403, "The request's origin is refused"));
    expect(safe).toMatchObject({
      errorName: "Refusal",
      errorCode: "invalid_origin",
      message: "The request's origin is refused",
    });
  });

  it("keeps a Node error code and refuses a free-text one", () => {
    const node = Object.assign(new Error("connect failed to 203.0.113.1"), {
      code: "ECONNREFUSED",
    });
    expect(safeError(node)).toMatchObject({ errorName: "Error", errorCode: "ECONNREFUSED" });
    const free = Object.assign(new Error("x"), { code: "some free text" });
    expect(safeError(free).errorCode).toBe("unexpected");
  });

  it("handles values that are not errors", () => {
    expect(safeError("a string with a secret")).toEqual({
      errorName: "string",
      errorCode: "unexpected",
      frames: [],
    });
    expect(safeError(null).errorName).toBe("null");
    expect(safeError(undefined).errorName).toBe("undefined");
  });

  it("parses both V8 frame forms and keeps at most 20 frames", () => {
    const error = new Error("x");
    error.stack = [
      "Error: x",
      "    at handle (/app/dist/main.js:10:3)",
      "    at /app/dist/main.js:11:4",
      "    at async Promise.all (index 0)",
      ...Array.from({ length: 30 }, (_, i) => `    at f${i} (file:///app/dist/main.js:${i + 1}:1)`),
    ].join("\n");
    const frames = safeError(error).frames;
    expect(frames[0]).toEqual({ file: "/app/dist/main.js", line: 10, column: 3, fn: "handle" });
    expect(frames[1]).toEqual({ file: "/app/dist/main.js", line: 11, column: 4 });
    expect(frames).toHaveLength(20);
  });

  it("never reads a frame from a message line, however it is shaped", () => {
    for (const message of [
      "lookup failed for customer\n    at Jane Doe (12 Acacia Avenue, Leeds:1:1)",
      'invalid input syntax for type integer: "1\n    at Jane (/customers/jane/iban:4111:1111)',
      "first\n    at /vault/hunter2-Password/card:1:1\n    at Evil (file:///x.js:2:2)",
    ]) {
      const safe = safeError(new Error(message));
      const text = JSON.stringify(safe);
      expect(text, message).not.toMatch(/Jane|Acacia|customers|hunter2|Evil|x\.js/);
      expect(safe.frames.length, message).toBeGreaterThan(0);
      expect(safe.frames[0]?.file).toMatch(/safe-error\.test\.ts$/);
    }
  });

  it("finds the header of Node's own errors, which carry their code in it", () => {
    let caught: unknown;
    try {
      new URL("not a url\n    at Jane (/a:1:1)");
    } catch (error) {
      caught = error;
    }
    const safe = safeError(caught);
    expect(safe.errorCode).toBe("ERR_INVALID_URL");
    expect(JSON.stringify(safe)).not.toContain("Jane");
    expect(safe.frames.length).toBeGreaterThan(0);
    const coded = Object.assign(new TypeError("bad\n    at Jane (/a:1:1)"), {
      code: "ERR_X",
    });
    coded.stack = `TypeError [ERR_X]: bad\n    at Jane (/a:1:1)\n    at real (/app/dist/main.js:3:4)`;
    expect(safeError(coded).frames).toEqual([
      { file: "/app/dist/main.js", line: 3, column: 4, fn: "real" },
    ]);
  });

  it("keeps no frame when the header cannot be found, nor a line V8 could not have written", () => {
    const changed = new Error("first\n    at Jane (/a:1:1)");
    void changed.stack;
    changed.message = "second";
    expect(safeError(changed).frames).toEqual([]);
    const replaced = new Error("x");
    replaced.stack = "Something else\n    at Jane (/a:1:1)";
    expect(stackFrameLines(replaced)).toEqual([]);
    const long = new Error("x");
    long.stack = `Error: x\n    at ${"f".repeat(2000)} (/app/a.js:1:1)\n    at ok (/app/a.js:2:2)`;
    expect(safeError(long).frames).toEqual([{ file: "/app/a.js", line: 2, column: 2, fn: "ok" }]);
    const odd = new Error("x");
    odd.stack = "Error: x\n    at fn (some words, here:1:1)\n    at fn2 (/app/a.js:2:2)";
    expect(safeError(odd).frames).toEqual([{ file: "/app/a.js", line: 2, column: 2, fn: "fn2" }]);
  });
});

describe("safeException", () => {
  it("stands in for an error with its class, a withheld message and the kept frames only", () => {
    const error = new TypeError("for jane@example.com\n    at Jane (/customers/jane:1:1)");
    const stand = safeException(error);
    expect(stand.name).toBe("TypeError");
    expect(stand.message).toBe("[withheld]");
    const lines = String(stand.stack).split("\n");
    expect(lines[0]).toBe("TypeError: [withheld]");
    expect(lines.slice(1).every((line) => /^ {4}at /.test(line))).toBe(true);
    expect(stand.stack).not.toMatch(/jane|Jane|customers/);
    expect(lines.length - 1).toBe(safeError(error).frames.length);
  });

  it("keeps a FinError's fixed words, on one line", () => {
    const stand = safeException(new Refusal("forbidden", 403, "Fin's own\nwords"));
    expect(stand.name).toBe("Refusal");
    expect(stand.message).toBe("Fin's own words");
  });
});

describe("Clock", () => {
  it("writes RFC 3339 with milliseconds and moves only when told", () => {
    const clock = createManualClock(Date.UTC(2026, 10, 21, 9, 0, 0, 5));
    expect(rfc3339(clock.now())).toBe("2026-11-21T09:00:00.005Z");
    clock.advance(1000);
    expect(rfc3339(clock.now())).toBe("2026-11-21T09:00:01.005Z");
    clock.set(0);
    expect(clock.now()).toBe(0);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
  });
});
