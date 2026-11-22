// The sidebar's width by the person's choice: expanded (224px) or collapsed to the 64px rail, from
// the edge toggle (spec 06 §4.2, [UI-11]). The choice applies only from 1280px; from 1024 to 1279px
// the width forces the rail, and below 1024px there is no sidebar, only the phone sheet.
import { useCallback, useSyncExternalStore } from "react";
import { documentRoot, subscribeToRootAttributes } from "./root.ts";
import { PREF_KEYS, writePref } from "./storage.ts";

export type SidebarState = "expanded" | "collapsed";

/** The state theme.js (or the last toggle) left on <html>; expanded when nothing says otherwise. */
export function currentSidebar(): SidebarState {
  return documentRoot()?.getAttribute("data-sidebar") === "collapsed" ? "collapsed" : "expanded";
}

/** Stores the choice and applies it at once; false when storage refused it (this page only). */
export function setSidebar(next: SidebarState): boolean {
  const stored = writePref(PREF_KEYS.sidebar, next);
  documentRoot()?.setAttribute("data-sidebar", next);
  return stored;
}

const subscribe = (onChange: () => void) => subscribeToRootAttributes(["data-sidebar"], onChange);

/** Whether the person collapsed the sidebar, and the setter the edge toggle calls. */
export function useSidebar(): { collapsed: boolean; setCollapsed: (next: boolean) => void } {
  const state = useSyncExternalStore(subscribe, currentSidebar, () => "expanded" as const);
  const setCollapsed = useCallback((next: boolean) => {
    setSidebar(next ? "collapsed" : "expanded");
  }, []);
  return { collapsed: state === "collapsed", setCollapsed };
}
