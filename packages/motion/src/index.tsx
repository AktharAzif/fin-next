// @fin/motion: the React side of the motion layer (spec 06 §5.1). The motion itself is CSS
// (fin-motion.css); these helpers only put its classes in the right place at the right time.
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { initialNavigationRun, navigationDraw, nextNavigationRun } from "./navigation-run.ts";

function join(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/**
 * Fades its content in, rising 4px, each time `keyBy` changes: AppFrame keys it by the pathname,
 * so `?tab=`, `?view=` and filters never replay it. Each AuthCard carries the class itself.
 */
export function Enter(props: { keyBy: string; className?: string; children: ReactNode }) {
  return (
    <div key={props.keyBy} className={join("fin-enter", props.className)}>
      {props.children}
    </div>
  );
}

/**
 * Shows `fallback` (a skeleton) until `ready`, then the content, which fades in where the
 * skeleton was: a tab panel, a drawer body or a section loading in place.
 */
export function Swap(props: {
  ready: boolean;
  fallback: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  if (!props.ready) return <>{props.fallback}</>;
  return <div className={join("fin-swap", props.className)}>{props.children}</div>;
}

/**
 * The navigation bar over the content while the router is pending. It grows from the left once
 * per navigation and stays mounted afterwards, fading out over 140ms, because CSS cannot animate
 * an element that has left the page; that includes the first load, when the frame mounts while the
 * router is already pending. Before any navigation it draws nothing. The frame gives it its place
 * and colour through `className` (a 2px bar of text-primary across the top of the content).
 */
export function NavigationBar(props: { pending: boolean; className?: string }) {
  const [state, setState] = useState(() => initialNavigationRun(props.pending));
  // React's pattern for state that follows a prop: set during render, re-rendered before commit.
  const next = nextNavigationRun(state, props.pending);
  if (next !== state) setState(next);
  const draw = navigationDraw(next);
  if (draw.kind === "nothing") return null;
  return draw.kind === "bar" ? (
    <div
      key={draw.key}
      role="progressbar"
      aria-label="Loading"
      className={join("fin-progress", props.className)}
    />
  ) : (
    <div key={draw.key} aria-hidden="true" className={join("fin-swap-out", props.className)} />
  );
}

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const list = window.matchMedia(QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * Whether the person asked for less motion. Only for motion run from script; everything in CSS
 * already follows the media query.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
