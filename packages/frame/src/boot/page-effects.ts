// What the root does to the document around navigations (spec 06 §2.5):
//   - on a new path, once the route has resolved, focus moves to the page's <h1> and the title is
//     announced once through the polite region (S6-17, AC-UI-27);
//   - a page restored from the back-forward cache is hidden before it can be seen and stays hidden
//     until the session has been checked again (FW-C14, FW-S4): the restored document still holds
//     the last person's page, and the session may have ended (Log out, then Back).
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

export interface BackForwardGuardInput {
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  /** The element React renders into (`#root`). */
  container: Pick<HTMLElement, "hidden">;
  /** Checks the session again (`GET /api/viewer`) and reloads the route's data. */
  recheck: () => Promise<unknown>;
  /** Reloads the document when the check cannot be made. */
  reload: () => void;
}

/**
 * Hides the app as it goes into the back-forward cache and as it comes back from it, and reveals it
 * only once `recheck` has answered: by then the page shows fresh data, or the sign-in page when the
 * session has gone. If the check fails, the document reloads, still hidden. Returns the remover.
 */
export function installBackForwardGuard(input: BackForwardGuardInput): () => void {
  const { target, container } = input;
  let newest = 0;
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) container.hidden = true;
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    container.hidden = true;
    newest += 1;
    const check = newest;
    input.recheck().then(
      () => {
        if (check === newest) container.hidden = false;
      },
      () => input.reload(),
    );
  };
  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);
  return () => {
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  };
}
