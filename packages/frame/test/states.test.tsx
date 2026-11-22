// The route states and the boot's notices, drawn on @fin/ui's kit (spec 06 §2.5, §5.2).
import { toast } from "@fin/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showReleaseToast } from "../src/boot/start.tsx";
import { isOffline, RouteNotAllowed, RoutePending } from "../src/states/RouteStates.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  toast.dismiss();
});

describe("route states", () => {
  it("draws pending as skeleton shapes with a status for screen readers, never a spinner", () => {
    const html = renderToStaticMarkup(<RoutePending />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("data-skeleton");
    expect(html).not.toContain("fin-ico-spin");
  });

  it("says the role doesn’t allow the page, with no way around it", () => {
    const html = renderToStaticMarkup(<RouteNotAllowed />);
    expect(html).toContain("You can’t open this page");
    expect(html).toContain("Your role doesn’t allow this. Ask someone who can change roles.");
    expect(html).not.toContain("<button");
  });

  it("blames the connection only when the browser says it is offline", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(isOffline()).toBe(true);
    vi.stubGlobal("navigator", { onLine: true });
    expect(isOffline()).toBe(false);
  });
});

describe("a new release", () => {
  it("shows one toast with Reload as its action", () => {
    expect(toast.count()).toBe(0);
    showReleaseToast();
    expect(toast.count()).toBe(1);
  });
});
