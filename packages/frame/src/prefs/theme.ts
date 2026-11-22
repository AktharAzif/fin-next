// The console's theme choice: Light, Dark or System, from the AccountMenu (spec 06 §4.3). Fin Admin
// and verify follow the system and offer no choice. The resolved theme is always explicit on <html>
// (`data-theme`), even for System, because the dark shimmer keys on `[data-theme="dark"]`.
import { useCallback, useSyncExternalStore } from "react";
import { documentRoot, subscribeToRootAttributes } from "./root.ts";
import { PREF_KEYS, writePref } from "./storage.ts";

export const THEME_CHOICES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ResolvedTheme = "light" | "dark";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Light or dark for a choice, given whether the system prefers dark. */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === "system") return systemPrefersDark ? "dark" : "light";
  return choice;
}

function systemPrefersDark(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  } catch {
    return false;
  }
}

/** Sets both theme attributes on an element (normally <html>). */
export function applyTheme(
  root: Pick<HTMLElement, "setAttribute">,
  choice: ThemeChoice,
  prefersDark: boolean,
): void {
  root.setAttribute("data-theme", resolveTheme(choice, prefersDark));
  root.setAttribute("data-theme-choice", choice);
}

/** The choice in force, as theme.js (or the last setter) left it on <html>. */
export function currentThemeChoice(): ThemeChoice {
  const value = documentRoot()?.getAttribute("data-theme-choice");
  return isThemeChoice(value) ? value : "system";
}

/** The theme drawn now. */
export function currentTheme(): ResolvedTheme {
  return documentRoot()?.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * Stores the choice and applies it at once. Returns false when storage refused it: the choice
 * still applies to this page, and theme.js falls back to the system theme on the next load.
 */
export function setThemeChoice(choice: ThemeChoice): boolean {
  const stored = writePref(PREF_KEYS.theme, choice);
  const root = documentRoot();
  if (root !== null) applyTheme(root, choice, systemPrefersDark());
  return stored;
}

const THEME_ATTRIBUTES = ["data-theme", "data-theme-choice"] as const;
const subscribe = (onChange: () => void) => subscribeToRootAttributes(THEME_ATTRIBUTES, onChange);

/** The theme choice and the drawn theme, kept in step with other tabs and the system. */
export function useTheme(): {
  choice: ThemeChoice;
  theme: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
} {
  const choice = useSyncExternalStore(subscribe, currentThemeChoice, () => "system" as const);
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as const);
  const setChoice = useCallback((next: ThemeChoice) => {
    setThemeChoice(next);
  }, []);
  return { choice, theme, setChoice };
}
