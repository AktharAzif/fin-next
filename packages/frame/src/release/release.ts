// Deploy skew (FW-C13, spec 06 §2.3 step 7). Every API answer carries `Fin-Release`; when it
// differs from the release env.json named at load, the frame offers one reload ("Fin was updated.
// Reload to get the latest version."), once per page. A chunk that fails to load after a deploy
// (`vite:preloadError`) reloads the document once, guarded by a session flag so a broken deploy
// cannot loop.

/** Calls `onNewRelease` the first time an answer names another release; later answers are ignored. */
export function createReleaseWatch(
  current: string,
  onNewRelease: (release: string) => void,
): (seen: string) => void {
  let told = false;
  return (seen) => {
    if (told || seen === current) return;
    told = true;
    onNewRelease(seen);
  };
}

export const RELOAD_FLAG = "fin-reloaded";

function readFlag(): boolean {
  try {
    return window.sessionStorage.getItem(RELOAD_FLAG) === "1";
  } catch {
    // Without session storage we cannot tell a second failure from the first: never reload.
    return true;
  }
}

function writeFlag(): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_FLAG, "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reloads once when Vite reports a chunk that failed to load. Returns the remover. The flag is
 * cleared after a page has run for a while without the error, so a later deploy can reload again.
 */
export function installPreloadErrorReload(
  reload: () => void = () => window.location.reload(),
): () => void {
  const onPreloadError = (event: Event) => {
    if (readFlag()) return;
    if (!writeFlag()) return;
    event.preventDefault();
    reload();
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  const clear = setTimeout(() => {
    try {
      window.sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
      // Nothing to clear.
    }
  }, 60_000);
  return () => {
    clearTimeout(clear);
    window.removeEventListener("vite:preloadError", onPreloadError);
  };
}
