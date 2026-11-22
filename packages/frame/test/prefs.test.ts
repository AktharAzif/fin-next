import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSidebar, setSidebar } from "../src/prefs/sidebar.ts";
import { readPref, writePref } from "../src/prefs/storage.ts";
import {
  applyTheme,
  currentTheme,
  currentThemeChoice,
  isThemeChoice,
  resolveTheme,
  setThemeChoice,
} from "../src/prefs/theme.ts";
import { createReleaseWatch, installPreloadErrorReload } from "../src/release/release.ts";
import {
  pendingReports,
  REPORT_QUEUE_LIMIT,
  reportBrowserError,
  setReportSink,
} from "../src/report/report.ts";

function fakeRoot() {
  const attributes = new Map<string, string>();
  return {
    attributes,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
}

function fakeStorage(throws = false) {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => {
      if (throws) throw new Error("SecurityError");
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (throws) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  };
}

function browser({ throws = false, prefersDark = false } = {}) {
  const root = fakeRoot();
  const local = fakeStorage(throws);
  const session = fakeStorage(throws);
  const listeners = new Map<string, (event: Event) => void>();
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    localStorage: local,
    sessionStorage: session,
    matchMedia: () => ({ matches: prefersDark }),
    addEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  return { root, local, session, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("storage", () => {
  it("reads and writes inside try/catch", () => {
    const { local } = browser();
    expect(writePref("fin-theme", "dark")).toBe(true);
    expect(local.values.get("fin-theme")).toBe("dark");
    expect(readPref("fin-theme")).toBe("dark");
  });

  it("never throws when storage is blocked", () => {
    browser({ throws: true });
    expect(writePref("fin-theme", "dark")).toBe(false);
    expect(readPref("fin-theme")).toBeNull();
  });

  it("does nothing outside a browser", () => {
    expect(readPref("fin-theme")).toBeNull();
    expect(writePref("fin-theme", "dark")).toBe(false);
  });
});

describe("theme", () => {
  it("resolves and applies the closed set", () => {
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("auto")).toBe(false);
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    const root = fakeRoot();
    applyTheme(root, "system", false);
    expect(Object.fromEntries(root.attributes)).toEqual({
      "data-theme": "light",
      "data-theme-choice": "system",
    });
  });

  it("stores a choice and applies it at once", () => {
    const { root, local } = browser({ prefersDark: true });
    expect(setThemeChoice("system")).toBe(true);
    expect(root.attributes.get("data-theme")).toBe("dark");
    expect(currentThemeChoice()).toBe("system");
    expect(currentTheme()).toBe("dark");
    setThemeChoice("light");
    expect(local.values.get("fin-theme")).toBe("light");
    expect(currentTheme()).toBe("light");
  });

  it("still applies the choice to this page when storage refuses it", () => {
    const { root } = browser({ throws: true });
    expect(setThemeChoice("dark")).toBe(false);
    expect(root.attributes.get("data-theme")).toBe("dark");
  });

  it("reads System and light outside a browser", () => {
    expect(currentThemeChoice()).toBe("system");
    expect(currentTheme()).toBe("light");
  });
});

describe("sidebar", () => {
  it("stores the edge toggle's choice and mirrors it on <html>", () => {
    const { root, local } = browser();
    expect(currentSidebar()).toBe("expanded");
    setSidebar("collapsed");
    expect(local.values.get("fin-sidebar")).toBe("collapsed");
    expect(root.attributes.get("data-sidebar")).toBe("collapsed");
    expect(currentSidebar()).toBe("collapsed");
  });
});

describe("release", () => {
  it("offers the reload once, and only for another release", () => {
    const told: string[] = [];
    const watch = createReleaseWatch("aaa", (release) => told.push(release));
    watch("aaa");
    watch("bbb");
    watch("ccc");
    expect(told).toEqual(["bbb"]);
  });

  it("reloads once on a failed chunk, never twice", () => {
    vi.useFakeTimers();
    const { listeners, session } = browser();
    const reload = vi.fn();
    const remove = installPreloadErrorReload(reload);
    const event = { preventDefault: vi.fn() } as unknown as Event;
    listeners.get("vite:preloadError")?.(event);
    listeners.get("vite:preloadError")?.(event);
    expect(reload).toHaveBeenCalledOnce();
    expect(session.values.get("fin-reloaded")).toBe("1");
    vi.advanceTimersByTime(60_000);
    expect(session.values.has("fin-reloaded")).toBe(false);
    remove();
  });

  it("never reloads when session storage is blocked", () => {
    const { listeners } = browser({ throws: true });
    const reload = vi.fn();
    installPreloadErrorReload(reload)();
    installPreloadErrorReload(reload);
    listeners.get("vite:preloadError")?.({ preventDefault: vi.fn() } as unknown as Event);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("report", () => {
  it("queues at most 20 reports until a sink is installed, oldest dropped", () => {
    setReportSink(null);
    for (let index = 0; index < REPORT_QUEUE_LIMIT + 5; index++)
      reportBrowserError(new Error(`e${index}`), { index: String(index) });
    expect(pendingReports()).toBe(REPORT_QUEUE_LIMIT);
    const seen: string[] = [];
    setReportSink((_error, ids) => {
      seen.push(ids.index ?? "");
    });
    expect(seen[0]).toBe("5");
    expect(seen).toHaveLength(REPORT_QUEUE_LIMIT);
    expect(pendingReports()).toBe(0);
    reportBrowserError(new Error("later"), { index: "late" });
    expect(seen.at(-1)).toBe("late");
  });

  it("survives a sink that throws", () => {
    setReportSink(() => {
      throw new Error("sink down");
    });
    expect(() => reportBrowserError(new Error("x"))).not.toThrow();
    setReportSink(null);
  });
});
