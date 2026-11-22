// NavigationBar's state, apart from React so its whole life can be tested without a DOM: whether
// the router is pending, which navigation the bar is drawing, and what it draws (spec 06 §5.1).

export type NavigationRun = { readonly pending: boolean; readonly run: number };

/** What the bar draws: nothing, or the bar or its fade-out, keyed so each run mounts afresh. */
export type NavigationDraw =
  | { readonly kind: "nothing" }
  | { readonly kind: "bar" | "fade-out"; readonly key: string };

/**
 * The first state. A bar mounted while the router is pending (the frame's first load) is drawing
 * that load, run 1, so it ends in the fade-out like every later navigation; mounted idle, it has
 * drawn nothing yet (run 0).
 */
export function initialNavigationRun(pending: boolean): NavigationRun {
  return { pending, run: pending ? 1 : 0 };
}

/** The next state: each start of a pending spell is a new run. An unchanged state is returned as is. */
export function nextNavigationRun(state: NavigationRun, pending: boolean): NavigationRun {
  if (pending === state.pending) return state;
  return { pending, run: pending ? state.run + 1 : state.run };
}

/** Before any run, nothing; then the bar while pending, and its fade-out once the run ends. */
export function navigationDraw(state: NavigationRun): NavigationDraw {
  if (state.run === 0) return { kind: "nothing" };
  return state.pending
    ? { kind: "bar", key: String(state.run) }
    : { kind: "fade-out", key: `${state.run}-out` };
}
