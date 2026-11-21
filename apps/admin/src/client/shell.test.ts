// Fin Admin's shell as it ships (spec 06 §2.2, §6.2, §6.4 checks 1, 2 and 7): index.html under the
// page policy with the boot skeletons equal to @fin/frame's, public/theme.js equal to the frame's,
// static.json with exactly spec 01 §7.4's keys, and every route declaring its static data, none
// under /api.
import adminSkeleton from "@fin/frame/boot/admin-skeleton.html?raw";
import authSkeleton from "@fin/frame/boot/auth-skeleton.html?raw";
import frameThemeJs from "@fin/frame/boot/theme.js?raw";
import type { AnyRoute } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import themeJs from "../../public/theme.js?raw";
import staticJsonText from "../../static.json?raw";
import { createAppRouter } from "./router.ts";

const APP = "admin";
const BLOCKS: Record<string, string> = { app: adminSkeleton, auth: authSkeleton };

function block(html: string, name: string): string | null {
  const start = html.indexOf(`<!-- boot:${name} -->`);
  const end = html.indexOf(`<!-- /boot:${name} -->`);
  if (start < 0 || end < 0) return null;
  return html.slice(start + `<!-- boot:${name} -->`.length, end);
}

describe("index.html", () => {
  it("names the app and carries one nonce-less csp-nonce meta", () => {
    expect(indexHtml).toContain(`<html lang="en-GB" data-app="${APP}">`);
    const metas = indexHtml.match(/<meta\b[^>]*property="csp-nonce"[^>]*>/g) ?? [];
    expect(metas).toEqual(['<meta property="csp-nonce">']);
    expect(indexHtml).not.toMatch(/\snonce\s*=/i);
  });

  it("loads theme.js first, render-blocking, then the module entry", () => {
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map((s) => s[1]?.trim())).toEqual([
      'src="/theme.js"',
      'type="module" src="/src/client/main.tsx"',
    ]);
    for (const script of scripts) expect(script[2]).toBe("");
  });

  it("has no inline handler, style attribute or style element, and a shimmering body", () => {
    expect(indexHtml).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(indexHtml).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
    expect(indexHtml).not.toMatch(/<style\b/i);
    expect(indexHtml).toContain('<body class="fin-shimmer">');
    expect(indexHtml).toMatch(/<a class="sr-only[^"]*" href="#main">Skip to content<\/a>/);
  });

  it("holds the frame's boot skeletons byte for byte", () => {
    for (const [name, skeleton] of Object.entries(BLOCKS)) {
      expect(block(indexHtml, name)?.trim(), name).toBe(skeleton.trim());
    }
  });
});

describe("public/theme.js", () => {
  it("is @fin/frame's boot/theme.js byte for byte (S6-05)", () => {
    expect(themeJs).toBe(frameThemeJs);
  });
});

describe("static.json", () => {
  it("holds exactly the assets-only settings (spec 01 §7.4)", () => {
    expect(JSON.parse(staticJsonText)).toEqual({
      compatibility_date: "2026-11-20",
      assets: {
        not_found_handling: "single-page-application",
        html_handling: "auto-trailing-slash",
      },
      workers_dev: false,
      preview_urls: false,
    });
  });
});

describe("routes", () => {
  // The route tree as the app's router builds it, so every route counts however its file is named
  // or grouped: a `(group)` folder or a pathless layout adds no segment, and a `.ts` file is a route
  // as much as a `.tsx` one.
  const router = createAppRouter({ fin: {} as never });
  const routes = (Object.values(router.routesById) as AnyRoute[]).filter((route) => !route.isRoot);

  it("has no route under /api (AC-UI-20)", () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(route.fullPath, route.id).not.toMatch(/^\/api(\/|$)/i);
  });

  it("declares a frame and a page name on every route (S6-01)", () => {
    for (const route of routes) {
      const data = route.options.staticData as Record<string, unknown> | undefined;
      expect(data?.frame, route.id).toMatch(/^(app|auth|bare)$/);
      expect(typeof data?.pageName, route.id).toBe("string");
      expect(data !== undefined && "navId" in data, route.id).toBe(true);
    }
  });
});
