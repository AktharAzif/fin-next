// One page section's data, loaded through api() (spec 06 §2.4: no query library, no retry loop).
// The first load draws the section's skeleton; a reload after a change keeps what is on screen
// (`refreshing`); a failure keeps the page's header and tabs and shows the section's error with Try
// again. Only the newest load's answer is kept, and a load is aborted when the section unmounts or
// its inputs change, so a slow answer never replaces a newer one.
import { useCallback, useEffect, useRef, useState } from "react";

export type ResourceStatus = "loading" | "ready" | "refreshing" | "error";

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  error: unknown;
  /** Loads again, keeping the data on screen; resolves once it has settled. */
  reload(): Promise<void>;
  /** Replaces the data in place (an answer that already says what changed). */
  set(next: T): void;
}

interface State<T> {
  status: ResourceStatus;
  data: T | null;
  error: unknown;
}

/**
 * Loads `load` when the section mounts and whenever `key` changes (a search, a page). `load` gets
 * an AbortSignal it passes to api(); `enabled: false` loads nothing (a role without the
 * permission: the server would refuse, and the page draws its no-permission state instead).
 */
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  options: { enabled?: boolean } = {},
): Resource<T> {
  const enabled = options.enabled !== false;
  const [state, setState] = useState<State<T>>({
    status: enabled ? "loading" : "ready",
    data: null,
    error: null,
  });
  const run = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const controller = useRef<AbortController | null>(null);

  const start = useCallback((keep: boolean): Promise<void> => {
    run.current += 1;
    const mine = run.current;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setState((previous) => ({
      status: keep && previous.data !== null ? "refreshing" : "loading",
      data: keep ? previous.data : null,
      error: null,
    }));
    return loadRef.current(next.signal).then(
      (data) => {
        if (mine === run.current) setState({ status: "ready", data, error: null });
      },
      (error: unknown) => {
        if (mine !== run.current || next.signal.aborted) return;
        setState((previous) => ({ status: "error", data: previous.data, error }));
      },
    );
  }, []);

  // `key` names what the load depends on: a new key loads again.
  useEffect(() => {
    if (!enabled) return;
    void start(false);
    return () => {
      run.current += 1;
      controller.current?.abort();
    };
  }, [key, enabled, start]);

  return {
    ...state,
    reload: () => (enabled ? start(true) : Promise.resolve()),
    set: (data) => setState({ status: "ready", data, error: null }),
  };
}
