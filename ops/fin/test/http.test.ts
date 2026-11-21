import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderError } from "../src/core/errors.ts";
import { type HttpRequest, send } from "../src/core/http.ts";

/** A response whose body breaks after its first chunk, as a dropped connection does. */
function breaksMidBody(): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        return;
      }
      controller.error(new TypeError("terminated"));
    },
  });
  return new Response(body, { status: 200 });
}

function timers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

const GET: HttpRequest = {
  method: "GET",
  url: "https://api.example.com/x",
  headers: { authorization: "Bearer never-printed" },
  idempotent: true,
};

describe("send", () => {
  it("maps a body that breaks mid-read to a ProviderError, retries a read, and clears its timers", async () => {
    let calls = 0;
    const before = timers();
    await assert.rejects(
      send("cloudflare", GET, {
        fetch: async () => {
          calls++;
          return breaksMidBody();
        },
        sleep: async () => {},
        timeoutMs: 60_000,
      }),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError, String(e));
        assert.equal(e.status, 0);
        assert.match(e.message, /cloudflare GET: network error/);
        assert.equal(e.message.includes("never-printed"), false);
        return true;
      },
    );
    assert.equal(calls, 3);
    assert.equal(timers(), before, "no timeout timer is left running");
  });

  it("never repeats a write whose answer was lost", async () => {
    let calls = 0;
    await assert.rejects(
      send(
        "cloudflare",
        { ...GET, method: "POST", body: "{}", idempotent: false },
        {
          fetch: async () => {
            calls++;
            return breaksMidBody();
          },
          sleep: async () => {},
        },
      ),
      ProviderError,
    );
    assert.equal(calls, 1);
  });

  it("times out a body that never ends", async () => {
    await assert.rejects(
      send("cloudflare", GET, {
        fetch: async (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init.signal?.addEventListener("abort", () =>
                  controller.error(new DOMException("aborted", "AbortError")),
                );
              },
            }),
          ),
        sleep: async () => {},
        timeoutMs: 20,
        attempts: 2,
      }),
      /cloudflare GET: timed out/,
    );
  });

  it("returns the answer and retries a retryable status", async () => {
    const statuses = [503, 200];
    const answer = await send("cloudflare", GET, {
      fetch: async () => new Response("ok", { status: statuses.shift() ?? 500 }),
      sleep: async () => {},
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.text, "ok");
  });
});
