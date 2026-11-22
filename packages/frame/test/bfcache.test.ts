// A page put in the back-forward cache is hidden as it leaves, and stays hidden when it comes back
// until the session has been checked again (FW-C14, FW-S4; spec 06 §2.5).
import { describe, expect, it, vi } from "vitest";
import bootCss from "../boot/boot.css?raw";
import { guardBackForwardCache, LOCK_ATTRIBUTE } from "../src/boot/bfcache.ts";

function transition(type: "pagehide" | "pageshow", persisted: boolean): Event {
  return Object.assign(new Event(type), { persisted });
}

function fakeRoot() {
  const attributes = new Set<string>();
  return {
    attributes,
    setAttribute: (name: string) => {
      attributes.add(name);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const target = new EventTarget();
  const root = fakeRoot();
  const pending: ReturnType<typeof deferred<boolean>>[] = [];
  const recheck = vi.fn(() => {
    const next = deferred<boolean>();
    pending.push(next);
    return next.promise;
  });
  const reload = vi.fn();
  const stop = guardBackForwardCache({ target, root, recheck, reload });
  const locked = () => root.attributes.has(LOCK_ATTRIBUTE);
  return { target, root, pending, recheck, reload, stop, locked };
}

describe("the back-forward cache guard", () => {
  it("hides the page as it goes into the cache", () => {
    const { target, locked, recheck } = setup();
    target.dispatchEvent(transition("pagehide", true));
    expect(locked()).toBe(true);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("ignores a page that is unloading for good and an ordinary first show", () => {
    const { target, locked, recheck } = setup();
    target.dispatchEvent(transition("pagehide", false));
    target.dispatchEvent(transition("pageshow", false));
    expect(locked()).toBe(false);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("keeps a restored page hidden until the session check passes, then shows it", async () => {
    const { target, pending, locked, reload } = setup();
    target.dispatchEvent(transition("pagehide", true));
    target.dispatchEvent(transition("pageshow", true));
    expect(locked()).toBe(true);
    await settle();
    expect(locked()).toBe(true);
    pending[0]?.resolve(true);
    await settle();
    expect(locked()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("hides a restored page even when no pagehide was seen", async () => {
    const { target, pending, locked } = setup();
    target.dispatchEvent(transition("pageshow", true));
    expect(locked()).toBe(true);
    pending[0]?.resolve(true);
    await settle();
    expect(locked()).toBe(false);
  });

  it("reloads the document, still hidden, when the viewer changed or the check failed", async () => {
    for (const outcome of ["changed", "failed"] as const) {
      const { target, pending, locked, reload } = setup();
      target.dispatchEvent(transition("pageshow", true));
      if (outcome === "changed") pending[0]?.resolve(false);
      else pending[0]?.reject(new Error("offline"));
      await settle();
      expect(reload, outcome).toHaveBeenCalledTimes(1);
      expect(locked(), outcome).toBe(true);
    }
  });

  it("lets only the latest restore decide", async () => {
    const { target, pending, locked, reload } = setup();
    target.dispatchEvent(transition("pageshow", true));
    target.dispatchEvent(transition("pagehide", true));
    target.dispatchEvent(transition("pageshow", true));
    pending[0]?.resolve(true);
    await settle();
    expect(locked()).toBe(true);
    pending[1]?.resolve(true);
    await settle();
    expect(locked()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops listening when the root unmounts", () => {
    const { target, stop, locked } = setup();
    stop();
    target.dispatchEvent(transition("pagehide", true));
    expect(locked()).toBe(false);
  });

  it("hides everything in the body while locked, in CSS alone", () => {
    expect(bootCss).toContain(`html[${LOCK_ATTRIBUTE}] body`);
    expect(bootCss).toMatch(/visibility:\s*hidden\s*!important/);
  });
});
