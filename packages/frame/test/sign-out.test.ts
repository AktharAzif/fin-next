// Log out (FW-C14): the page is hidden before the full document load of /sign-in, with the
// back-forward guard's own lock, so the guard that lifts it decides what a restore shows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { signOut } from "../src/api/sign-out.ts";
import { LOCK_ATTRIBUTE } from "../src/boot/bfcache.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Log out (FW-C14)", () => {
  it("hides the page before the full document load, so Back never shows it", async () => {
    const steps: string[] = [];
    const ok = await signOut({
      app: "console",
      fetch: async () => new Response(null, { status: 200 }),
      hide: () => steps.push("hide"),
      assign: (path) => steps.push(`assign ${path}`),
    });
    expect(ok).toBe(true);
    expect(steps).toEqual(["hide", "assign /sign-in"]);
  });

  it("hides with the back-forward guard's lock on <html>, which a passing recheck lifts", async () => {
    const attributes = new Map<string, string>();
    const container = { hidden: false };
    vi.stubGlobal("document", {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
      },
      getElementById: () => container,
    });
    const steps: string[] = [];
    const ok = await signOut({
      app: "admin",
      fetch: async () => new Response(null, { status: 200 }),
      assign: (path) => steps.push(`assign ${path} locked=${attributes.has(LOCK_ATTRIBUTE)}`),
    });
    expect(ok).toBe(true);
    expect(steps).toEqual(["assign /sign-in locked=true"]);
    expect(attributes.get(LOCK_ATTRIBUTE)).toBe("");
    // Nothing the guard does not undo: the root itself is left as it was.
    expect(container.hidden).toBe(false);
  });

  it("leaves the page as it is when the session could not be ended", async () => {
    const steps: string[] = [];
    const ok = await signOut({
      app: "console",
      fetch: async () => new Response(null, { status: 503 }),
      hide: () => steps.push("hide"),
      assign: (path) => steps.push(`assign ${path}`),
    });
    expect(ok).toBe(false);
    expect(steps).toEqual([]);
  });
});
