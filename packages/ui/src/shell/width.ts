// The shell's three widths (spec 06 §4.1, S6-06; the breakpoints of theme.css): `wide` from 1280px
// (the sidebar by the person's choice), `medium` from 1024px to 1279px (the rail, forced), `narrow`
// below 1024px (the phone shell). Read from matchMedia, kept current, and `wide` where there is no
// window (static markup in unit tests).
import { useSyncExternalStore } from "react";

export type ShellWidth = "wide" | "medium" | "narrow";

export const WIDE_QUERY = "(min-width: 80rem)";
export const MEDIUM_QUERY = "(min-width: 64rem)";

function matches(query: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : true;
  } catch {
    return true;
  }
}

export function currentShellWidth(): ShellWidth {
  if (matches(WIDE_QUERY)) return "wide";
  return matches(MEDIUM_QUERY) ? "medium" : "narrow";
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const lists = [window.matchMedia(WIDE_QUERY), window.matchMedia(MEDIUM_QUERY)];
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

export function useShellWidth(): ShellWidth {
  return useSyncExternalStore(subscribe, currentShellWidth, () => "wide" as const);
}
