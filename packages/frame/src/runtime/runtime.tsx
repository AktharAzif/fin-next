// What every app's root holds once env.json and the viewer have answered (spec 06 §2.3): the app's
// name, the environment's public settings, the `api()` client, the viewer, the StepUp controller and
// the release notice. The router's context carries it as `fin`, so loaders reach `api()`, and the
// frames read it from React context.
import type { AppName } from "@fin/app-contracts";
import { createContext, type ReactNode, useContext } from "react";
import type { Api, ApiHooks } from "../api/client.ts";
import type { FinEnv } from "../env/env.ts";
import type { StepUpController } from "../step-up/step-up.tsx";
import type { Store } from "./store.ts";
import type { ViewerStore } from "./viewer.ts";

export interface FinRuntime<V = unknown> {
  readonly app: AppName;
  readonly env: FinEnv;
  readonly api: Api;
  /**
   * Adds or replaces the api() hooks it names. The frame's own (spec 06 §2.4's whole table) are in
   * place from boot; a hook not named here stays as the frame installed it.
   */
  configureApi(hooks: ApiHooks): void;
  readonly viewer: ViewerStore<V>;
  readonly stepUp: StepUpController;
  /** The release a newer API answer named, once (FW-C13); null until then. */
  readonly newRelease: Store<string | null>;
  /** Whether the app has a route for a pathname: the check a sign-in `next` must pass (FW-C09). */
  routeExists(pathname: string): boolean;
}

/** The router context every app's root route declares. */
export interface FinRouterContext<V = unknown> {
  fin: FinRuntime<V>;
}

const FinContext = createContext<FinRuntime | null>(null);

export function FinRuntimeProvider({
  runtime,
  children,
}: {
  runtime: FinRuntime;
  children: ReactNode;
}) {
  return <FinContext.Provider value={runtime}>{children}</FinContext.Provider>;
}

export function useFin<V = unknown>(): FinRuntime<V> {
  const runtime = useContext(FinContext);
  if (runtime === null) throw new Error("useFin() needs FinRuntimeProvider at the app's root");
  return runtime as FinRuntime<V>;
}
