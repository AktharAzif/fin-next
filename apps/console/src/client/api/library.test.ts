import { isApiError } from "@fin/frame";
import { describe, expect, it } from "vitest";
import { totpVerify } from "./contracts/auth.ts";
import { ceremonyApi, LIBRARY_PROBLEM_TYPE, libraryFetch, liftLibraryError } from "./library.ts";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function recorder(answer: () => Response) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    seen.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : null,
    });
    return answer();
  };
  return { seen, fetchImpl };
}

const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });

describe("libraryFetch", () => {
  it("sends a body-less POST under /api/auth/ as {} with a JSON content type", async () => {
    const { seen, fetchImpl } = recorder(() => json(200, {}));
    await libraryFetch({ lift: false, fetch: fetchImpl })("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "X-Fin-App": "console" },
    });
    expect(seen[0]?.body).toBe("{}");
    expect(seen[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(seen[0]?.headers.get("X-Fin-App")).toBe("console");
  });

  it("leaves a GET and a Fin route alone", async () => {
    const { seen, fetchImpl } = recorder(() => json(200, {}));
    const run = libraryFetch({ lift: false, fetch: fetchImpl });
    await run("/api/auth/passkey/generate-authenticate-options", { method: "GET" });
    await run("/api/account/sessions/revoke-others", { method: "POST" });
    expect(seen.map((s) => s.body)).toEqual([null, null]);
    expect(seen.map((s) => s.headers.has("Content-Type"))).toEqual([false, false]);
  });

  it("names the proved intent on every request of a ceremony", async () => {
    const { seen, fetchImpl } = recorder(() => json(200, {}));
    await libraryFetch({ lift: true, intentId: "sti_1", fetch: fetchImpl })(
      "/api/auth/two-factor/verify-totp",
      { method: "POST", body: '{"code":"123456"}' },
    );
    expect(seen[0]?.headers.get("Fin-Step-Up-Intent")).toBe("sti_1");
    expect(seen[0]?.body).toBe('{"code":"123456"}');
  });
});

describe("liftLibraryError", () => {
  it("turns the library's { code, message } into a problem document with the same status", async () => {
    const lifted = await liftLibraryError(
      json(401, { code: "INVALID_CODE", message: "Invalid code" }),
    );
    expect(lifted.status).toBe(401);
    expect(lifted.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await lifted.json()).toEqual({
      type: LIBRARY_PROBLEM_TYPE,
      title: "Invalid code",
      status: 401,
      code: "INVALID_CODE",
    });
  });

  it("passes Fin's own problems, successes and unreadable bodies through", async () => {
    const fin = json(403, { code: "step_up_required" }, "application/problem+json");
    expect(await liftLibraryError(fin)).toBe(fin);
    const ok = json(200, { code: "X" });
    expect(await liftLibraryError(ok)).toBe(ok);
    const text = new Response("nope", { status: 502, headers: { "Content-Type": "text/html" } });
    expect(await liftLibraryError(text)).toBe(text);
    const noCode = json(400, { message: "no code" });
    expect(await liftLibraryError(noCode)).toBe(noCode);
  });
});

describe("ceremonyApi", () => {
  it("throws an ApiError that carries the library's code", async () => {
    const { seen, fetchImpl } = recorder(() => json(401, { code: "INVALID_CODE", message: "x" }));
    const error = await ceremonyApi("sti_9", fetchImpl)(totpVerify, { code: "000000" }).catch(
      (e: unknown) => e,
    );
    expect(isApiError(error)).toBe(true);
    expect(isApiError(error) && error.code).toBe("INVALID_CODE");
    expect(isApiError(error) && error.status).toBe(401);
    expect(seen[0]?.url).toBe("/api/auth/two-factor/verify-totp");
    expect(seen[0]?.headers.get("X-Fin-App")).toBe("console");
    expect(seen[0]?.headers.get("Fin-Step-Up-Intent")).toBe("sti_9");
  });
});
