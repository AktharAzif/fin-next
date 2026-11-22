// boot/theme.js runs before the body is parsed. These tests run the real file against a stand-in
// document and window, as each app's <head> would, and read the attributes it leaves on <html>.
import { afterEach, describe, expect, it, vi } from "vitest";

interface Setup {
  app: "console" | "admin" | "verify";
  path?: string;
  stored?: Record<string, string>;
  storageThrows?: boolean;
  prefersDark?: boolean;
  noMatchMedia?: boolean;
}

async function runThemeJs(setup: Setup) {
  const attributes = new Map<string, string>([["data-app", setup.app]]);
  const root = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const stored = { ...setup.stored };
  const media = {
    matches: setup.prefersDark === true,
    listeners: [] as (() => void)[],
    addEventListener(_type: string, listener: () => void) {
      this.listeners.push(listener);
    },
  };
  const windowListeners: Record<string, (event: { key: string | null }) => void> = {};
  const win: Record<string, unknown> = {
    location: { pathname: setup.path ?? "/" },
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
      windowListeners[type] = listener;
    },
  };
  if (setup.noMatchMedia !== true) win.matchMedia = () => media;
  Object.defineProperty(win, "localStorage", {
    get() {
      if (setup.storageThrows === true) throw new Error("SecurityError: storage is blocked");
      return { getItem: (key: string) => stored[key] ?? null };
    },
  });
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", win);
  vi.resetModules();
  await import("../boot/theme.js");
  return { attributes, stored, media, windowListeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("boot/theme.js", () => {
  it("applies the console's stored dark theme and collapsed sidebar", async () => {
    const { attributes } = await runThemeJs({
      app: "console",
      stored: { "fin-theme": "dark", "fin-sidebar": "collapsed" },
    });
    expect(attributes.get("data-theme")).toBe("dark");
    expect(attributes.get("data-theme-choice")).toBe("dark");
    expect(attributes.get("data-sidebar")).toBe("collapsed");
    expect(attributes.get("data-boot")).toBe("app");
  });

  it("makes System explicit from the media query", async () => {
    const dark = await runThemeJs({ app: "console", prefersDark: true });
    expect(dark.attributes.get("data-theme")).toBe("dark");
    expect(dark.attributes.get("data-theme-choice")).toBe("system");
    const light = await runThemeJs({ app: "console", prefersDark: false });
    expect(light.attributes.get("data-theme")).toBe("light");
  });

  it("ignores a stored value outside the closed set", async () => {
    const { attributes } = await runThemeJs({
      app: "console",
      stored: { "fin-theme": "purple", "fin-sidebar": "wide" },
    });
    expect(attributes.get("data-theme-choice")).toBe("system");
    expect(attributes.get("data-sidebar")).toBe("expanded");
  });

  it("renders the system theme with the sidebar expanded when storage throws", async () => {
    const { attributes } = await runThemeJs({
      app: "console",
      storageThrows: true,
      prefersDark: true,
    });
    expect(attributes.get("data-theme")).toBe("dark");
    expect(attributes.get("data-theme-choice")).toBe("system");
    expect(attributes.get("data-sidebar")).toBe("expanded");
  });

  it("survives an engine without matchMedia", async () => {
    const { attributes } = await runThemeJs({ app: "console", noMatchMedia: true });
    expect(attributes.get("data-theme")).toBe("light");
  });

  it("lets Fin Admin follow the system, never a stored theme, but keep its sidebar", async () => {
    const { attributes } = await runThemeJs({
      app: "admin",
      stored: { "fin-theme": "dark", "fin-sidebar": "collapsed" },
      prefersDark: false,
    });
    expect(attributes.get("data-theme")).toBe("light");
    expect(attributes.get("data-theme-choice")).toBe("system");
    expect(attributes.get("data-sidebar")).toBe("collapsed");
  });

  it("gives verify the auth skeleton and no sidebar", async () => {
    const { attributes } = await runThemeJs({ app: "verify", path: "/c" });
    expect(attributes.get("data-boot")).toBe("auth");
    expect(attributes.has("data-sidebar")).toBe(false);
  });

  it("chooses the auth skeleton on the signed-out paths only", async () => {
    const cases: [Setup["app"], string, string][] = [
      ["console", "/sign-in", "auth"],
      ["console", "/sign-in/code", "auth"],
      ["console", "/welcome/secure", "auth"],
      ["console", "/invite", "auth"],
      ["console", "/sign-inside", "app"],
      ["console", "/settings/team", "app"],
      ["console", "/", "app"],
      ["admin", "/sign-in/factor", "auth"],
      ["admin", "/staff", "app"],
      ["admin", "/welcome", "app"],
    ];
    for (const [app, path, boot] of cases) {
      const { attributes } = await runThemeJs({ app, path });
      expect(`${app} ${path} ${attributes.get("data-boot")}`).toBe(`${app} ${path} ${boot}`);
    }
  });

  it("follows the system and other tabs while it runs", async () => {
    const run = await runThemeJs({ app: "console", prefersDark: false });
    expect(run.attributes.get("data-theme")).toBe("light");
    run.media.matches = true;
    for (const listener of run.media.listeners) listener();
    expect(run.attributes.get("data-theme")).toBe("dark");
    run.stored["fin-theme"] = "light";
    run.windowListeners.storage?.({ key: "fin-theme" });
    expect(run.attributes.get("data-theme")).toBe("light");
    run.stored["fin-sidebar"] = "collapsed";
    run.windowListeners.storage?.({ key: "unrelated" });
    expect(run.attributes.get("data-sidebar")).toBe("expanded");
    run.windowListeners.storage?.({ key: "fin-sidebar" });
    expect(run.attributes.get("data-sidebar")).toBe("collapsed");
  });
});
