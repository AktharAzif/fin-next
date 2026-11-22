// The person's per-host display choices (spec 06 §4.2, §5.3; [UI-13], [SA-43]). They live in
// localStorage under two keys and nowhere else: no cookie, no server. Every access is inside
// try/catch, because storage throws in a private window or with site data blocked, and a choice that
// cannot be stored must never break the page. This folder, `src/release/` and `boot/theme.js` are
// the only places that touch Web Storage (spec 06 §11.5).

export const PREF_KEYS = { theme: "fin-theme", sidebar: "fin-sidebar" } as const;
export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored value, or null when nothing is stored or storage is unavailable. */
export function readPref(key: PrefKey): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Stores the value; false when storage refused it (the choice then lasts for this page only). */
export function writePref(key: PrefKey, value: string): boolean {
  try {
    const store = storage();
    if (store === null) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
