// What the root does to the document around navigations: focus and the spoken title on a new path
// (S6-17, AC-UI-27).
import { describe, expect, it } from "vitest";
import { focusNewPage } from "../src/boot/page-effects.ts";

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
