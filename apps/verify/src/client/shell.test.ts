// Verify's shell as it ships (spec 06 §1.2, §2.2, §6.2, §6.4 checks 1, 2 and 7; S6-27): its two
// documents, index.html and the selfie host's selfie.html, under the page policy with the boot
// skeleton equal to @fin/frame's; public/theme.js and public-selfie/theme.js equal to the frame's;
// static.json with exactly spec 01 §7.4's keys; and every route of both entries declaring its
// static data, none under /api.

import authSkeleton from "@fin/frame/boot/auth-skeleton.html?raw";
import frameThemeJs from "@fin/frame/boot/theme.js?raw";
import type { AnyRoute, AnyRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import favicon from "../../public/favicon.svg?raw";
import themeJs from "../../public/theme.js?raw";
import selfieFavicon from "../../public-selfie/favicon.svg?raw";
import selfieThemeJs from "../../public-selfie/theme.js?raw";
import selfieHtml from "../../selfie.html?raw";
import staticJsonText from "../../static.json?raw";
import { createSelfieRouter } from "../selfie/router.tsx";
import { createAppRouter } from "./router.ts";

const APP = "verify";
const BLOCKS: Record<string, string> = { auth: authSkeleton };

function block(html: string, name: string): string | null {
  const start = html.indexOf(`<!-- boot:${name} -->`);
  const end = html.indexOf(`<!-- /boot:${name} -->`);
  if (start < 0 || end < 0) return null;
  return html.slice(start + `<!-- boot:${name} -->`.length, end);
}

const DOCUMENTS = [
  { file: "index.html", html: indexHtml, entry: "/src/client/main.tsx" },
  { file: "selfie.html", html: selfieHtml, entry: "/src/selfie/main.tsx" },
] as const;

for (const { file, html, entry } of DOCUMENTS) {
  describe(file, () => {
    it("names the app and carries one nonce-less csp-nonce meta", () => {
      expect(html).toContain(`<html lang="en-GB" data-app="${APP}">`);
      const metas = html.match(/<meta\b[^>]*property="csp-nonce"[^>]*>/g) ?? [];
      expect(metas).toEqual(['<meta property="csp-nonce">']);
      expect(html).not.toMatch(/\snonce\s*=/i);
    });

    it("loads theme.js first, render-blocking, then the module entry", () => {
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts.map((s) => s[1]?.trim())).toEqual([
        'src="/theme.js"',
        `type="module" src="${entry}"`,
      ]);
      for (const script of scripts) expect(script[2]).toBe("");
    });

    it("has no inline handler, style attribute or style element, and a shimmering body", () => {
      expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
      expect(html).not.toMatch(/<style\b/i);
      expect(html).toContain('<body class="fin-shimmer">');
      expect(html).toMatch(/<a class="sr-only[^"]*" href="#main">Skip to content<\/a>/);
    });

    it("holds the frame's boot skeletons byte for byte", () => {
      for (const [name, skeleton] of Object.entries(BLOCKS)) {
        expect(block(html, name)?.trim(), name).toBe(skeleton.trim());
      }
    });

    it("carries only the auth block: every verify page is a signed-out card", () => {
      expect(block(html, "app")).toBeNull();
    });
  });
}

describe("the two documents", () => {
  it("differ only in their entry module", () => {
    expect(selfieHtml.replace("/src/selfie/main.tsx", "/src/client/main.tsx")).toBe(indexHtml);
  });
});

describe("public/ and public-selfie/", () => {
  it("hold @fin/frame's boot/theme.js byte for byte (S6-05, S6-27)", () => {
    expect(themeJs).toBe(frameThemeJs);
    expect(selfieThemeJs).toBe(frameThemeJs);
  });

  it("hold the same favicon", () => {
    expect(selfieFavicon).toBe(favicon);
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

/** Every route but the root, as the entry's router builds them. */
function routesOf(router: AnyRouter): AnyRoute[] {
  return (Object.values(router.routesById) as AnyRoute[]).filter((route) => !route.isRoot);
}

const ROUTERS: ReadonlyArray<readonly [string, AnyRouter]> = [
  ["verify", createAppRouter({ fin: {} as never })],
  ["selfie", createSelfieRouter({ fin: {} as never })],
];

for (const [name, router] of ROUTERS) {
  describe(`${name} routes`, () => {
    // The route tree as the entry's router builds it, so every route counts however its file is
    // named or grouped: a `(group)` folder or a pathless layout adds no segment, and a `.ts` file
    // is a route as much as a `.tsx` one.
    const routes = routesOf(router);

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
}

describe("the selfie entry", () => {
  it("answers /s alone, in AuthFrame (spec 06 §7.3)", () => {
    const routes = routesOf(createSelfieRouter({ fin: {} as never }));
    expect(routes.map((route) => route.fullPath)).toEqual(["/s"]);
    expect(routes[0]?.options.staticData).toMatchObject({ frame: "auth", navId: null });
  });
});
