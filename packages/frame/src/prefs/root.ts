// The attributes `boot/theme.js` sets on <html> before the first paint are the one source of truth
// for the theme and the sidebar while the page runs: theme.js keeps them in step with the system
// theme and with other tabs (the `storage` event), and the setters here write the same storage
// keys and the same attributes, so a choice applies at once in this tab too (spec 06 §5.3).

/** The element the attributes live on, or null outside a browser (unit tests, static markup). */
export function documentRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

/**
 * Calls `onChange` whenever one of the named attributes of <html> changes, whoever changed it.
 * Returns the unsubscribe function `useSyncExternalStore` expects.
 */
export function subscribeToRootAttributes(
  attributes: readonly string[],
  onChange: () => void,
): () => void {
  const root = documentRoot();
  if (root === null || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: [...attributes] });
  return () => observer.disconnect();
}
