/* Fin's theme bootstrap (spec 06 §5.3, [UI-13]). A classic, render-blocking, same-origin script
 * loaded from <head> before the body is parsed, so the stored theme and sidebar width apply before
 * the first paint with no inline script (script-src 'self'). Each app's public/theme.js is a byte
 * for byte copy of this file (S6-05), checked by packages/frame/tools/ui-check.mjs.
 *
 * It sets, from closed sets only:
 *   data-theme         "light" | "dark", explicit even for System (the dark shimmer keys on it)
 *   data-theme-choice  "light" | "dark" | "system"
 *   data-sidebar       "expanded" | "collapsed" (console and Fin Admin)
 *   data-boot          "app" | "auth", which static skeleton in index.html shows
 * Only the console offers a theme choice; Fin Admin and verify follow the system. Every storage
 * read is inside try/catch: with storage blocked the page renders in the system theme with the
 * sidebar expanded, and nothing fails. */
(() => {
  const root = document.documentElement;
  const app = root.getAttribute("data-app");
  const AUTH_PREFIXES = {
    console: [
      "/sign-in",
      "/sign-up",
      "/verify-email",
      "/reset-password",
      "/invite",
      "/no-access",
      "/welcome",
    ],
    admin: ["/sign-in"],
  };
  let media = null;
  try {
    media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
  } catch {
    media = null;
  }

  const read = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const apply = () => {
    let choice = app === "console" ? read("fin-theme") : null;
    if (choice !== "light" && choice !== "dark") choice = "system";
    const dark =
      choice === "dark" || (choice === "system" && media !== null && media.matches === true);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.setAttribute("data-theme-choice", choice);
    if (app === "console" || app === "admin") {
      root.setAttribute(
        "data-sidebar",
        read("fin-sidebar") === "collapsed" ? "collapsed" : "expanded",
      );
    }
  };

  const boot = () => {
    if (app === "verify") return "auth";
    const prefixes = app === "console" || app === "admin" ? AUTH_PREFIXES[app] : [];
    const path = window.location.pathname;
    return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      ? "auth"
      : "app";
  };

  root.setAttribute("data-boot", boot());
  apply();
  try {
    if (media !== null && typeof media.addEventListener === "function")
      media.addEventListener("change", apply);
  } catch {
    // An engine without MediaQueryList events keeps the theme it started with.
  }
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "fin-theme" || event.key === "fin-sidebar") apply();
  });
})();
