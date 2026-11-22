// The signed-in viewer as the frame holds it: the answer of `GET /api/viewer` (spec 02 §14.4), or
// null when it answered 401 (no session). Loaded once at entry, in parallel with env.json, and again
// after anything that changes it (choosing another organisation).
import type { AppContract, ContractOutput } from "@fin/app-contracts";
import type { Api } from "../api/client.ts";
import { isApiError } from "../api/errors.ts";
import { createStore, type Store } from "./store.ts";

export interface ViewerStore<V> extends Store<V | null> {
  /**
   * Fetches the viewer again and resolves with what it fetched. Only the newest reload's answer is
   * stored: when reloads overlap (an organisation switch and a back-forward check), an older answer
   * that arrives later never replaces a newer one.
   */
  reload(): Promise<V | null>;
}

/** Calls the viewer route: the viewer, null on 401, and any other failure thrown. */
export async function fetchViewer<C extends AppContract>(
  api: Api,
  contract: C,
): Promise<ContractOutput<C> | null> {
  try {
    return await api(contract, {} as never);
  } catch (error) {
    if (isApiError(error) && error.status === 401) return null;
    throw error;
  }
}

export function createViewerStore<V>(
  initial: V | null,
  load: () => Promise<V | null>,
): ViewerStore<V> {
  const store = createStore<V | null>(initial);
  let newest = 0;
  return {
    ...store,
    async reload() {
      newest += 1;
      const run = newest;
      const next = await load();
      if (run === newest) store.set(next);
      return next;
    },
  };
}
