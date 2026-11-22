// The back-forward cache (FW-C14, FW-S4; spec 06 §2.5). A page the browser keeps in that cache comes
// back as it was left, so after a sign-out and Back it would still show the person's page. As the
// page goes into the cache it is hidden (boot.css hides everything in <body> under the lock
// attribute); when it comes back it stays hidden until the session has been checked again. If the
// check passes the page shows again; if the viewer changed or the check failed, the document
// reloads while still hidden, so nothing of the earlier session is drawn.

/** Set on <html> while the page may not be shown. boot.css holds the rule. */
export const LOCK_ATTRIBUTE = "data-locked";

export interface BackForwardGuardOptions {
  /** Where `pagehide` and `pageshow` fire: the window. */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** The element the lock attribute goes on: <html>. */
  root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };
  /**
   * Checks the session again and brings the page up to date. Resolves true when the page may show
   * again, false when the document must reload instead.
   */
  recheck: () => Promise<boolean>;
  /** A full document load: `location.reload()`. */
  reload: () => void;
}

function persisted(event: Event): boolean {
  return (event as PageTransitionEvent).persisted === true;
}

/** Installs the guard; returns the function that removes it. */
export function guardBackForwardCache(options: BackForwardGuardOptions): () => void {
  const { target, root, recheck, reload } = options;
  let restore = 0;
  const lock = () => root.setAttribute(LOCK_ATTRIBUTE, "");

  const onPageHide = (event: Event) => {
    if (persisted(event)) lock();
  };
  const onPageShow = (event: Event) => {
    if (!persisted(event)) return;
    lock();
    restore += 1;
    const current = restore;
    recheck().then(
      (show) => {
        if (current !== restore) return;
        if (show) root.removeAttribute(LOCK_ATTRIBUTE);
        else reload();
      },
      () => {
        if (current === restore) reload();
      },
    );
  };

  target.addEventListener("pagehide", onPageHide);
  target.addEventListener("pageshow", onPageShow);
  return () => {
    target.removeEventListener("pagehide", onPageHide);
    target.removeEventListener("pageshow", onPageShow);
  };
}

/** Whether two answers of the viewer route describe the same session. */
export function sameViewer(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}
