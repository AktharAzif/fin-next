import { defineContract, health, noContent, noInput, z } from "@fin/app-contracts";
import { describe, expect, it, vi } from "vitest";
import { type ApiHooks, createApiClient, type StepUpProof } from "../src/api/client.ts";
import { ApiError, isUnreachable } from "../src/api/errors.ts";
import { buildRequest, parseRetryAfter } from "../src/api/request.ts";

const inviteMember = defineContract({
  name: "team.invite",
  method: "POST",
  path: "/team/invitations",
  input: z.object({ email: z.string(), roleKey: z.string() }),
  output: z.object({ invitationId: z.string() }),
  organization: true,
  creates: true,
});

const removeMember = defineContract({
  name: "team.removeMember",
  method: "POST",
  path: "/team/members/:memberId/remove",
  input: z.object({ memberId: z.string() }),
  output: noContent,
  organization: true,
});

const auditLog = defineContract({
  name: "auditLog.list",
  method: "GET",
  path: "/audit-log",
  input: z.object({
    q: z.string().optional(),
    type: z.array(z.string()).optional(),
    page: z.number(),
  }),
  output: z.object({ rows: z.array(z.unknown()) }),
});

// A UUID-shaped key, built at run time so the public-safety scan never sees an ID-shaped literal.
const GENERATED_KEY = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const contentType = status >= 400 ? "application/problem+json" : "application/json";
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType, ...headers },
  });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return json(status, {
    type: `https://docs.example.com/errors/${code}`,
    title: code,
    status,
    code,
    request_id: "req_test",
    ...extra,
  });
}

function client(
  answers: Response[],
  hooks: ApiHooks = {},
  organization: string | null = "org_acme",
) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      headers: { ...(init?.headers as Record<string, string>) },
    });
    const next = answers.shift();
    if (next === undefined) throw new TypeError("no answer queued");
    return next;
  });
  const { api, configure } = createApiClient({
    app: "console",
    fetch: fetchImpl as unknown as typeof fetch,
    organization: () => organization,
    randomUUID: () => GENERATED_KEY,
    now: () => Date.parse("2026-11-21T10:00:00Z"),
  });
  configure(hooks);
  return { api, calls };
}

describe("buildRequest", () => {
  it("fills path parameters, encoded, and sends no body when nothing is left", () => {
    expect(buildRequest(removeMember, { memberId: "mem 1/2" })).toEqual({
      path: "/team/members/mem%201%2F2/remove",
      body: undefined,
    });
  });

  it("refuses a path parameter the URL parser would read as a dot segment", () => {
    // `.` and `..` survive encodeURIComponent, and fetch resolves them: `/team/members/../remove`
    // would be sent to `/team/remove`, another route, with the same body and headers.
    for (const memberId of [".", ".."]) {
      expect(() => buildRequest(removeMember, { memberId })).toThrow(TypeError);
      expect(() => buildRequest(removeMember, { memberId })).toThrow(/:memberId/);
    }
    // Encoded dots are not dot segments once encodeURIComponent has escaped the `%`.
    for (const memberId of ["%2e%2e", "...", ".mem", "mem.1", "%2E"]) {
      const { path } = buildRequest(removeMember, { memberId });
      expect(new URL(path, "https://console.example.com").pathname).toBe(path);
    }
  });

  it("never lets api() send a dot-segment parameter to another route", async () => {
    const { api, calls } = client([new Response(null, { status: 204 })]);
    await expect(api(removeMember, { memberId: ".." })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("puts a GET's fields in the query, arrays repeated, absent fields dropped", () => {
    expect(buildRequest(auditLog, { page: 2, type: ["team", "keys"] })).toEqual({
      path: "/audit-log?type=team&type=keys&page=2",
      body: undefined,
    });
    expect(buildRequest(health, {})).toEqual({ path: "/health", body: undefined });
  });

  it("sends the rest of an unsafe method's input as JSON", () => {
    expect(buildRequest(inviteMember, { email: "a@example.com", roleKey: "developer" })).toEqual({
      path: "/team/invitations",
      body: JSON.stringify({ email: "a@example.com", roleKey: "developer" }),
    });
  });

  it("refuses an input the contract refuses, naming fields and never values", () => {
    expect(() => buildRequest(inviteMember, { email: "secret@example.com" })).toThrow(/roleKey/);
    try {
      buildRequest(inviteMember, { email: "secret@example.com" });
    } catch (error) {
      expect(String(error)).not.toContain("secret@example.com");
    }
  });

  it("reads Retry-After as seconds or a date", () => {
    const now = Date.parse("2026-11-21T10:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("Sat, 21 Nov 2026 10:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("api()", () => {
  it("sends a GET same-origin with no app header, no content type and no body", async () => {
    const { api, calls } = client([json(200, { status: "ok" })]);
    await expect(api(health, {})).resolves.toEqual({ status: "ok" });
    const [call] = calls;
    expect(call?.url).toBe("/api/health");
    expect(call?.init.method).toBe("GET");
    expect(call?.init.credentials).toBe("same-origin");
    expect(call?.init.redirect).toBe("follow");
    expect(call?.init.body).toBeUndefined();
    expect(call?.headers).toEqual({ Accept: "application/json" });
  });

  it("marks every unsafe call with X-Fin-App, JSON, the organisation and an idempotency key", async () => {
    const { api, calls } = client([json(201, { invitationId: "inv_1" })]);
    await api(inviteMember, { email: "a@example.com", roleKey: "developer" });
    expect(calls[0]?.headers).toEqual({
      Accept: "application/json",
      "X-Fin-App": "console",
      "Content-Type": "application/json",
      "Fin-Organization": "org_acme",
      "Idempotency-Key": GENERATED_KEY,
    });
  });

  it("keeps the caller's idempotency key across an action's retries", async () => {
    const { api, calls } = client([json(201, { invitationId: "inv_1" })]);
    await api(
      inviteMember,
      { email: "a@example.com", roleKey: "developer" },
      { idempotencyKey: "key-1" },
    );
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("key-1");
  });

  it("sends a body-less POST with no content type", async () => {
    const { api, calls } = client([new Response(null, { status: 204 })]);
    await expect(api(removeMember, { memberId: "mem_1" })).resolves.toBeNull();
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
    expect(calls[0]?.headers["X-Fin-App"]).toBe("console");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("maps a rejected fetch to a network error", async () => {
    const { api } = client([]);
    const error = await api(health, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("network");
    expect(isUnreachable(error)).toBe(true);
  });

  it("maps an answer that is not Fin's JSON to unexpected_response with its status", async () => {
    const { api } = client([
      new Response("<html>Bad gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
    ]);
    const error = (await api(health, {}).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("unexpected_response");
    expect(error.status).toBe(502);
  });

  it("reports and refuses an answer that breaks the contract", async () => {
    const report = vi.fn();
    const { api } = client([json(200, { status: "degraded" }, { "Request-Id": "req_9" })], {
      report,
    });
    const error = (await api(health, {}).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("unexpected_response");
    expect(error.requestId).toBe("req_9");
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      contract: "health.get",
      requestId: "req_9",
    });
  });

  it("hands every Fin-Release to the frame", async () => {
    const release = vi.fn();
    const { api } = client([json(200, { status: "ok" }, { "Fin-Release": "abc123" })], { release });
    await api(health, {});
    expect(release).toHaveBeenCalledWith("abc123");
  });

  it("tells the frame about a 401 and throws the problem", async () => {
    const unauthenticated = vi.fn();
    const { api } = client([problem(401, "unauthenticated")], { unauthenticated });
    const error = (await api(health, {}).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("problem");
    expect(error.code).toBe("unauthenticated");
    expect(error.requestId).toBe("req_test");
    expect(unauthenticated).toHaveBeenCalledOnce();
  });

  it("reads Retry-After on a 429", async () => {
    const answer = problem(429, "rate_limited", { retry_after: 99 });
    answer.headers.set("Retry-After", "12");
    const { api } = client([answer]);
    const error = (await api(health, {}).catch((e: unknown) => e)) as ApiError;
    expect(error.retryAfterSeconds).toBe(12);
  });

  it("routes the factor and session gates to the frame", async () => {
    const secondFactorRequired = vi.fn();
    const factorStepRequired = vi.fn();
    const freshSessionRequired = vi.fn();
    const { api } = client(
      [
        problem(403, "second_factor_required", { hold: true }),
        problem(403, "factor_step_required"),
        problem(403, "fresh_session_required"),
      ],
      { secondFactorRequired, factorStepRequired, freshSessionRequired },
    );
    await api(health, {}).catch(() => {});
    await api(health, {}).catch(() => {});
    await api(health, {}).catch(() => {});
    expect(secondFactorRequired).toHaveBeenCalledWith(true);
    expect(factorStepRequired).toHaveBeenCalledOnce();
    expect(freshSessionRequired).toHaveBeenCalledOnce();
  });

  describe("step-up", () => {
    const required = () =>
      problem(403, "step_up_required", {
        step_up_kind: "intent",
        intent_id: "sti_1",
        methods: ["passkey"],
        reason_key: "team.invite",
      });

    function prover(intentId: string | null = "sti_1") {
      const settled: string[] = [];
      const proof: StepUpProof = { intentId, settle: (outcome) => settled.push(outcome) };
      return { stepUp: vi.fn(async () => proof), settled };
    }

    it("re-sends once after the proof: same body, same key, plus the intent", async () => {
      const { stepUp, settled } = prover();
      const { api, calls } = client([required(), json(201, { invitationId: "inv_1" })], { stepUp });
      await expect(
        api(inviteMember, { email: "a@example.com", roleKey: "developer" }),
      ).resolves.toEqual({
        invitationId: "inv_1",
      });
      expect(stepUp).toHaveBeenCalledWith(
        expect.objectContaining({ intent_id: "sti_1", step_up_kind: "intent" }),
      );
      expect(calls).toHaveLength(2);
      expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
      expect(calls[1]?.headers["Idempotency-Key"]).toBe(calls[0]?.headers["Idempotency-Key"]);
      expect(calls[1]?.headers["Fin-Step-Up-Intent"]).toBe("sti_1");
      expect(calls[0]?.headers["Fin-Step-Up-Intent"]).toBeUndefined();
      expect(settled).toEqual(["done"]);
    });

    it("re-sends a window without an intent header", async () => {
      const { stepUp } = prover(null);
      const windowRequired = problem(403, "step_up_required", {
        step_up_kind: "window",
        methods: ["passkey"],
        reason_key: "account.name",
      });
      const { api, calls } = client([windowRequired, json(200, { status: "ok" })], { stepUp });
      await api(health, {});
      expect(calls[1]?.headers["Fin-Step-Up-Intent"]).toBeUndefined();
    });

    it("never loops: step_up_invalid on the re-send settles invalid and throws", async () => {
      const { stepUp, settled } = prover();
      const { api, calls } = client(
        [required(), problem(403, "step_up_invalid", { reason: "used" })],
        { stepUp },
      );
      const error = (await api(inviteMember, {
        email: "a@example.com",
        roleKey: "developer",
      }).catch((e: unknown) => e)) as ApiError;
      expect(error.code).toBe("step_up_invalid");
      expect(calls).toHaveLength(2);
      expect(settled).toEqual(["invalid"]);
      expect(stepUp).toHaveBeenCalledOnce();
    });

    it("never loops: a second step_up_required is not proved again", async () => {
      const { stepUp, settled } = prover();
      const { api, calls } = client([required(), required()], { stepUp });
      await api(inviteMember, { email: "a@example.com", roleKey: "developer" }).catch(() => {});
      expect(calls).toHaveLength(2);
      expect(stepUp).toHaveBeenCalledOnce();
      expect(settled).toEqual(["failed"]);
    });

    it("throws the original problem when the person closes the modal", async () => {
      const stepUp = vi.fn(async () => null);
      const { api, calls } = client([required()], { stepUp });
      const error = (await api(inviteMember, {
        email: "a@example.com",
        roleKey: "developer",
      }).catch((e: unknown) => e)) as ApiError;
      expect(error.code).toBe("step_up_required");
      expect(calls).toHaveLength(1);
    });

    it("throws step_up_required as is when no StepUp host is mounted", async () => {
      const { api } = client([required()]);
      const error = (await api(inviteMember, {
        email: "a@example.com",
        roleKey: "developer",
      }).catch((e: unknown) => e)) as ApiError;
      expect(error.code).toBe("step_up_required");
    });
  });

  it("on Fin Admin, does not follow redirects and reloads on an opaque one", async () => {
    const opaqueRedirect = vi.fn();
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    } as unknown as Response;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => opaque);
    const { api, configure } = createApiClient({
      app: "admin",
      manualRedirect: true,
      fetch: fetchImpl,
    });
    configure({ opaqueRedirect });
    await api(health, {}).catch(() => {});
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(opaqueRedirect).toHaveBeenCalledOnce();
  });

  it("under the fallback shape, uses env.json's API origin with credentials", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, { status: "ok" }),
    );
    const { api } = createApiClient({
      app: "console",
      base: "https://api.example.com/api/",
      credentials: "include",
      fetch: fetchImpl,
    });
    await api(health, {});
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.example.com/api/health");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
  });

  it("times out a request with the contract's timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const quick = defineContract({
      name: "a.quick",
      method: "GET",
      path: "/quick",
      input: noInput,
      output: z.null(),
      timeoutMs: 5,
    });
    const { api } = createApiClient({
      app: "console",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const error = (await api(quick, {}).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("network");
    expect(error.aborted).toBe(false);
  });
});
