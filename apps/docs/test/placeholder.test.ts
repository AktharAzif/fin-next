// The docs placeholder as it ships (spec 01 §4.5, §7.4; spec 06 §6.4): one static page under the
// page policy (no inline script, handler, style attribute or nonce; a nonce-less csp-nonce meta;
// no <svg> or <math>, so the wordmark is an <img>), theme.js equal to @fin/frame's, static.json with
// exactly the allowed keys, and no /api/ path.
import frameThemeJs from "@fin/frame/boot/theme.js?raw";
import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import themeJs from "../public/theme.js?raw";
import wordmark from "../public/wordmark.svg?raw";
import staticJsonText from "../static.json?raw";

describe("the docs placeholder", () => {
  it("carries one nonce-less csp-nonce meta and only external scripts", () => {
    expect(indexHtml.match(/<meta\b[^>]*property="csp-nonce"[^>]*>/g)).toEqual([
      '<meta property="csp-nonce">',
    ]);
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map((s) => [s[1]?.trim(), s[2]])).toEqual([['src="/theme.js"', ""]]);
    expect(indexHtml).not.toMatch(/\snonce\s*=|<[a-z][^>]*\s(?:on[a-z]+|style)\s*=|<style\b/i);
  });

  it("has no <svg> or <math> element: the wordmark is an <img> from its own origin", () => {
    // static:check refuses foreign content in a built index.html; this holds before any build.
    expect(indexHtml).not.toMatch(/<(?:svg|math)[\s/>]/i);
    expect(indexHtml).toContain('<img src="/wordmark.svg" alt="Fin.com" width="106" height="18">');
    expect(wordmark).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" [^>]*><title>Fin\.com</,
    );
  });

  it("names no /api/ path: the docs host has no API half", () => {
    expect(indexHtml).not.toMatch(/["'(]\/api(\/|["'?#)])/);
  });

  it("ships the frame's theme.js byte for byte", () => {
    expect(themeJs).toBe(frameThemeJs);
  });

  it("holds exactly the assets-only settings", () => {
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
