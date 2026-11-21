// The UI's source rules that unit tests can hold (spec 06 §11.5, AC-UI-01): in @fin/ui's source,
// no hex colour and no arbitrary Tailwind value in a class string, no dangerouslySetInnerHTML,
// innerHTML, setAttribute("style"), eval or new Function, no live region of a component's own, no
// refused SDK entry, and no copy with a straight apostrophe or "organization".
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A file's code with its block comments and whole-line comments left out. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every string literal and template literal in a file's code (comments left out). */
function strings(code: string): string[] {
  return [...withoutComments(code).matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

describe("@fin/ui's source", () => {
  const files = Object.entries(sources);

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("writes no hex colour and no arbitrary value in a class string", () => {
    const found: string[] = [];
    for (const [file, code] of files) {
      for (const value of strings(code)) {
        if (
          !/\b(?:bg|text|border|p[xytrbl]?|m[xytrbl]?|w|h|size|gap|rounded|shadow|inset|top|left|right|bottom|z|max-w|min-w|max-h|min-h|origin|translate|scale|duration|ease)-/.test(
            value,
          )
        )
          continue;
        if (/\[[^\]]*\]/.test(value)) found.push(`${file}: arbitrary value in "${value}"`);
        if (/#[0-9a-fA-F]{3,8}\b/.test(value)) found.push(`${file}: hex colour in "${value}"`);
      }
    }
    expect(found).toEqual([]);
  });

  it("uses none of the patterns the page policy and the lint rules refuse", () => {
    const refused = [
      /dangerouslySetInnerHTML/,
      /\.innerHTML\b/,
      /setAttribute\(\s*["']style["']/,
      /\beval\(/,
      /new Function\(/,
      /style=\{\{/,
      /console\.(?:log|error|warn)\(/,
    ];
    const found = files.flatMap(([file, code]) =>
      refused.filter((pattern) => pattern.test(code)).map((pattern) => `${file}: ${pattern}`),
    );
    expect(found).toEqual([]);
  });

  it("makes no live region of its own: spoken updates go through announce()", () => {
    // Spec 06 §3.3 and §9: each document has exactly one polite and one assertive region, the
    // SDK's. A role of alert, status or log, an aria-live or an <output> would add another.
    const refused = [
      /\brole=\{?\s*["'](?:alert|status|log|marquee|timer)["']/,
      /\brole:\s*["'](?:alert|status|log|marquee|timer)["']/,
      /aria-live/,
      /<output\b/,
    ];
    const found = files.flatMap(([file, code]) =>
      refused
        .filter((pattern) => pattern.test(withoutComments(code)))
        .map((pattern) => `${file}: ${pattern}`),
    );
    expect(found).toEqual([]);
  });

  it("imports no refused or experimental SDK entry", () => {
    const found = files.flatMap(([file, code]) =>
      [...code.matchAll(/from "(@ui-sdk\/[^"]+)"/g)]
        .map((m) => m[1] ?? "")
        .filter((entry) =>
          /\/agent|\/preferences|\/token-input|web\.css|\/label$|\/timeline|\/segmented-control|\/rating|\/color-picker|\/image-cropper|\/waterfall|\/testing/.test(
            entry,
          ),
        )
        .map((entry) => `${file}: ${entry}`),
    );
    expect(found).toEqual([]);
  });

  it("writes copy with typographic apostrophes and British spelling", () => {
    const found: string[] = [];
    for (const [file, code] of files) {
      for (const value of strings(code)) {
        if (!/\s/.test(value) || /[{}<>=:;]|^\s*[a-z-]+(\s+[a-z0-9:/.-]+)+\s*$/.test(value))
          continue;
        if (/[A-Za-z]'[A-Za-z]/.test(value))
          found.push(`${file}: straight apostrophe in "${value}"`);
        if (/\borganization\b/i.test(value)) found.push(`${file}: "organization" in "${value}"`);
      }
    }
    expect(found).toEqual([]);
  });
});
