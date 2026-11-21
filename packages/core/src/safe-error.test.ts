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
import { safeError } from "./safe-error.ts";

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
