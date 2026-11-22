// What the root does to the document around navigations (spec 06 §2.5): on a new path, once the
// route has resolved, focus moves to the page's <h1> and the title is announced once through the
// polite region (S6-17, AC-UI-27). A page restored from the back-forward cache is boot/bfcache.ts's.
import { announce } from "@fin/ui";

/**
 * Focuses the new page's <h1> (PageHeader's or AuthCard's, `tabIndex={-1}`), or the main region
 * when the page has none, without scrolling, and announces `title` once. A target that is not
 * focusable is made focusable (`tabindex="-1"`) first, so the move never silently does nothing.
 */
export function focusNewPage(
  root: ParentNode,
  title: string,
  say: (text: string) => void = announce,
): void {
  const target =
    root.querySelector<HTMLElement>("#main h1") ?? root.querySelector<HTMLElement>("#main");
  if (target !== null) {
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
  say(title);
}
