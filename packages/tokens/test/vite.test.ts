// finLayerOrder keeps `@layer ui-sdk;` the stylesheet's first statement (FW-C06).
import { describe, expect, it } from "vitest";
import { finLayerOrder, withUiSdkLayerFirst } from "../vite.ts";

describe("withUiSdkLayerFirst", () => {
  it("puts the declaration in front of Tailwind's properties fallback", () => {
    const built =
      "/*! tailwindcss v4 */@layer properties{@supports (x){*{--tw-a:0}}}@layer ui-sdk,theme;";
    const out = withUiSdkLayerFirst(built);
    expect(out.startsWith("@layer ui-sdk;\n/*! tailwindcss")).toBe(true);
    const body = out.replace(/^(?:\s|\/\*[\s\S]*?\*\/)*/, "");
    expect(body).toMatch(/^@layer\s+ui-sdk\b/);
  });

  it("leaves a stylesheet that already starts with the layer alone", () => {
    expect(withUiSdkLayerFirst("/* c */ @layer ui-sdk; a{}")).toBe("/* c */ @layer ui-sdk; a{}");
    expect(withUiSdkLayerFirst("@layer ui-sdk, theme; a{}")).toBe("@layer ui-sdk, theme; a{}");
    expect(withUiSdkLayerFirst("@layer ui-sdk{a{}}")).toBe("@layer ui-sdk{a{}}");
  });

  it("does not take a longer layer name for it", () => {
    for (const first of ["@layer ui-sdk-extra;", "@layer ui-sdk.inner;", "@layer ui-sdkx{}"]) {
      expect(withUiSdkLayerFirst(`${first} a{}`), first).toBe(`@layer ui-sdk;\n${first} a{}`);
    }
  });

  it("refuses a stylesheet with @charset, which must stay first", () => {
    expect(() => withUiSdkLayerFirst('@charset "utf-8"; a{}')).toThrow();
  });
});

describe("finLayerOrder", () => {
  it("rewrites every emitted stylesheet and nothing else", () => {
    const plugin = finLayerOrder();
    const bundle: Record<string, { type: string; fileName: string; source?: string | Uint8Array }> =
      {
        "a.css": { type: "asset", fileName: "assets/a.css", source: "@layer properties{}" },
        "b.css": {
          type: "asset",
          fileName: "assets/b.css",
          source: new TextEncoder().encode("x{}"),
        },
        "c.js": { type: "chunk", fileName: "assets/c.js" },
        "d.svg": { type: "asset", fileName: "assets/d.svg", source: "<svg/>" },
      };
    const hook = plugin.generateBundle as unknown as (o: unknown, b: typeof bundle) => void;
    hook.call({}, {}, bundle);
    expect(bundle["a.css"]?.source).toBe("@layer ui-sdk;\n@layer properties{}");
    expect(bundle["b.css"]?.source).toBe("@layer ui-sdk;\nx{}");
    expect(bundle["d.svg"]?.source).toBe("<svg/>");
    expect(plugin.apply).toBe("build");
  });
});
