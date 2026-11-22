// What the root does to the document around navigations: focus and the spoken title on a new path
// (S6-17, AC-UI-27), and a page restored from the back-forward cache kept hidden until the session
// has been checked again (FW-C14, FW-S4).
import { describe, expect, it, vi } from "vitest";
import { signOut } from "../src/api/sign-out.ts";
import { focusNewPage, installBackForwardGuard } from "../src/boot/page-effects.ts";

/** An element as focusNewPage uses it, recording what was done to it. */
function element(attributes: Record<string, string> = {}) {
  const attrs = new Map(Object.entries(attributes));
  const calls: unknown[] = [];
  return {
    calls,
    attrs,
    hasAttribute: (name: string) => attrs.has(name),
    setAttribute: (name: string, value: string) => {
      attrs.set(name, value);
    },
    focus: (options?: FocusOptions) => {
      calls.push(options);
    },
  };
}

function root(found: Record<string, ReturnType<typeof element> | null>) {
  return {
    querySelector: (selector: string) => found[selector] ?? null,
  } as unknown as ParentNode;
}

describe("focus on a new path (S6-17)", () => {
  it("moves focus to the page's h1 without scrolling and announces the title once", () => {
    const heading = element({ tabindex: "-1" });
    const said: string[] = [];
    focusNewPage(root({ "#main h1": heading }), "Sandbox · Team · Fin", (text) => said.push(text));
    expect(heading.calls).toEqual([{ preventScroll: true }]);
    expect(said).toEqual(["Sandbox · Team · Fin"]);
  });

  it("makes an h1 that is not focusable focusable first", () => {
    const heading = element();
    focusNewPage(root({ "#main h1": heading }), "Couldn’t load this page · Fin", () => {});
    expect(heading.attrs.get("tabindex")).toBe("-1");
    expect(heading.calls).toHaveLength(1);
  });

  it("falls back to the main region, and still announces, when the page has no h1", () => {
    const main = element();
    const said: string[] = [];
    focusNewPage(root({ "#main": main }), "Staff · Fin Admin", (text) => said.push(text));
    expect(main.attrs.get("tabindex")).toBe("-1");
    expect(main.calls).toHaveLength(1);
    expect(said).toEqual(["Staff · Fin Admin"]);
    const nothing: string[] = [];
    focusNewPage(root({}), "Page not found · Fin", (text) => nothing.push(text));
    expect(nothing).toEqual(["Page not found · Fin"]);
  });
});

/** A page transition event as the browser dispatches it. */
function transition(type: "pageshow" | "pagehide", persisted: boolean): Event {
  return Object.assign(new Event(type), { persisted });
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the back-forward cache (FW-C14, FW-S4)", () => {
  function guard() {
    const target = new EventTarget();
    const container = { hidden: false };
    const checks: ReturnType<typeof deferred>[] = [];
    const reload = vi.fn();
    const remove = installBackForwardGuard({
      target: target as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
      container,
      recheck: () => {
        const check = deferred();
        checks.push(check);
        return check.promise;
      },
      reload,
    });
    return { target, container, checks, reload, remove };
  }

  it("hides a restored page until the session has been checked again", async () => {
    const { target, container, checks } = guard();
    target.dispatchEvent(transition("pageshow", true));
    expect(container.hidden).toBe(true);
    expect(checks).toHaveLength(1);
    await flush();
    expect(container.hidden).toBe(true);
    checks[0]?.resolve();
    await flush();
    expect(container.hidden).toBe(false);
  });

  it("stores the page hidden as it goes into the cache, and leaves a first load alone", () => {
    const { target, container, checks } = guard();
    target.dispatchEvent(transition("pageshow", false));
    expect(container.hidden).toBe(false);
    expect(checks).toHaveLength(0);
    target.dispatchEvent(transition("pagehide", false));
    expect(container.hidden).toBe(false);
    target.dispatchEvent(transition("pagehide", true));
    expect(container.hidden).toBe(true);
  });

  it("reloads the document, still hidden, when the check cannot be made", async () => {
    const { target, container, checks, reload } = guard();
    target.dispatchEvent(transition("pageshow", true));
    checks[0]?.reject(new TypeError("Failed to fetch"));
    await flush();
    expect(reload).toHaveBeenCalledOnce();
    expect(container.hidden).toBe(true);
  });

  it("reveals only once the newest check has answered", async () => {
    const { target, container, checks, remove } = guard();
    target.dispatchEvent(transition("pageshow", true));
    target.dispatchEvent(transition("pageshow", true));
    checks[0]?.resolve();
    await flush();
    expect(container.hidden).toBe(true);
    checks[1]?.resolve();
    await flush();
    expect(container.hidden).toBe(false);
    remove();
    target.dispatchEvent(transition("pageshow", true));
    expect(checks).toHaveLength(2);
  });
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
