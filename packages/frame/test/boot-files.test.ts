// The boot files ship as they are into each app (spec 06 §2.2, §6.2): the skeletons go between the
// markers in index.html and theme.js into public/. Under `script-src 'self'; style-src 'self'` they
// may hold no inline script, handler, style attribute or nonce, and the skeletons only shapes.
import { describe, expect, it } from "vitest";
import adminSkeleton from "../boot/admin-skeleton.html?raw";
import appSkeleton from "../boot/app-skeleton.html?raw";
import authSkeleton from "../boot/auth-skeleton.html?raw";
import bootCss from "../boot/boot.css?raw";
import themeJs from "../boot/theme.js?raw";

const skeletons = { app: appSkeleton, admin: adminSkeleton, auth: authSkeleton };

describe("the boot skeletons", () => {
  for (const [name, html] of Object.entries(skeletons)) {
    it(`${name}: classes only, hidden from assistive technology, no script or style`, () => {
      expect(html).not.toMatch(
        /<script|<style|\sstyle\s*=|\son[a-z]+\s*=|nonce|<a\s|<button|tabindex/i,
      );
      expect(html).not.toMatch(/\[[^\]]*\]/); // no arbitrary Tailwind value
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i); // no hex colour
      expect(
        html
          .trimStart()
          .startsWith(
            `<div data-boot-block="${name === "auth" ? "auth" : "app"}" aria-hidden="true"`,
          ),
      ).toBe(true);
      expect(html).toContain("data-skeleton");
    });
  }

  it("lets CSS alone choose the block and the sidebar's width", () => {
    expect(bootCss).toContain('html:not([data-boot="auth"]) [data-boot-block="auth"]');
    expect(bootCss).toContain('html[data-boot="auth"] [data-boot-block="app"]');
    expect(bootCss).toContain('html[data-sidebar="collapsed"] [data-boot-sidebar]');
    expect(bootCss).toContain("var(--fin-layout-sidebar-collapsed)");
  });
});

describe("theme.js", () => {
  it("is a classic script that builds nothing from strings and stores nothing", () => {
    expect(themeJs).not.toMatch(
      /\beval\b|new Function|setTimeout\(\s*["'`]|innerHTML|document\.write|\bimport\b|\bexport\b/,
    );
    expect(themeJs).not.toMatch(/setItem|cookie/);
  });

  it("reads storage only inside try/catch", () => {
    const reads = [...themeJs.matchAll(/localStorage/g)];
    expect(reads).toHaveLength(1);
    const at = themeJs.indexOf("localStorage");
    const before = themeJs.slice(0, at);
    expect(before.lastIndexOf("try {")).toBeGreaterThan(before.lastIndexOf("}"));
  });

  it("sets only the four attributes, from closed sets", () => {
    const attributes = new Set(
      [...themeJs.matchAll(/setAttribute\(\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    expect([...attributes].sort()).toEqual([
      "data-boot",
      "data-sidebar",
      "data-theme",
      "data-theme-choice",
    ]);
  });
});
