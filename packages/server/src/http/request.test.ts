// The request unit's answers to what handlers throw (spec 02 §14.1; spec 05 §3.3; ARCHITECTURE
// §10.5, §13.2): a refusal answers its code, a dependency that is down answers 503 with
// `retry_after`, anything else is a reported, safe 500.
import { FinError, Refusal, UnavailableError } from "@fin/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { capture } from "../testing/capture.ts";
import type { FinEnv } from "./context.ts";
import { errorHandler, notFoundHandler, RETRY_AFTER_S, requestUnit } from "./request.ts";

function setup(thrown: () => unknown) {
  const captured = capture();
  const options = {
    telemetry: captured.telemetry,
    reporter: captured.reporter,
    clock: captured.clock,
    docsOrigin: "https://docs.example.net",
  };
  const app = new Hono<FinEnv>();
  app.onError(errorHandler(options));
  app.notFound(notFoundHandler(options));
  app.use(requestUnit(options));
  app.get("/api/x", () => {
    throw thrown();
  });
  return {
    captured,
    request: () => Promise.resolve(app.request("http://console.example.net/api/x")),
  };
}

describe("errorHandler", () => {
  it("answers an UnavailableError 503 with its code and retry_after, and reports nothing", async () => {
    const { captured, request } = setup(
      () => new UnavailableError("access_unavailable", "Access's signing keys could not be read"),
    );
    const res = await request();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(RETRY_AFTER_S));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 503,
      code: "access_unavailable",
      type: "https://docs.example.net/errors/access_unavailable",
      retry_after: RETRY_AFTER_S,
    });
    expect(body.request_id).toMatch(/^req_/);
    expect(captured.events("error.unexpected")).toHaveLength(0);
    expect(captured.events("request")[0]).toMatchObject({
      status: 503,
      outcome: "error",
      reason: "access_unavailable",
    });
    expect(captured.events("request")[0]?.errorId).toBeUndefined();
  });

  it("keeps the wait an UnavailableError names, and the extensions it may carry", async () => {
    const { request } = setup(
      () =>
        new UnavailableError("unavailable", "The limits store did not answer", {
          extensions: { retry_after: 30 },
        }),
    );
    const res = await request();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({ code: "unavailable", retry_after: 30 });
  });

  it("answers a refusal with its own status and code", async () => {
    const { captured, request } = setup(
      () => new Refusal("invalid_origin", 403, "The request's origin is refused"),
    );
    const res = await request();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "invalid_origin" });
    expect(captured.events("error.unexpected")).toHaveLength(0);
  });

  it("answers anything else, a FinError of 500 included, with a reported, safe 500", async () => {
    for (const thrown of [
      () => new TypeError("for jane@example.com"),
      () => new FinError("x", "y"),
    ]) {
      const { captured, request } = setup(thrown);
      const res = await request();
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("internal");
      expect(JSON.stringify(body)).not.toContain("jane");
      expect(captured.events("error.unexpected")).toHaveLength(1);
      expect(captured.events("request")[0]).toMatchObject({
        status: 500,
        outcome: "error",
        reason: "internal",
        errorId: expect.any(String),
      });
    }
  });
});
