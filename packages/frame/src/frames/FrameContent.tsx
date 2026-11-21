// What a frame puts in its content area: the page, keyed by pathname for the entrance, or the route
// state its static data calls for. A route whose `needs` the viewer lacks renders RouteNotAllowed;
// a Sandbox-only route renders RouteNotFound in Production ([SA-16], spec 06 §2.5). The server
// refuses regardless: this only mirrors it.
import type { ReactNode } from "react";
import { Enter } from "../motion/Enter.tsx";
import type { FinStaticData } from "../router/static-data.ts";
import { RouteNotAllowed, RouteNotFound } from "../states/RouteStates.tsx";

export function routeAllowed(
  staticData: FinStaticData | null,
  can: (permission: string) => boolean,
): boolean {
  return (staticData?.needs ?? []).every((permission) => can(permission));
}

export function FrameContent({
  pathname,
  staticData,
  can,
  environment,
  children,
}: {
  pathname: string;
  staticData: FinStaticData | null;
  can: (permission: string) => boolean;
  environment: "sandbox" | "production";
  children: ReactNode;
}) {
  let page = children;
  if (staticData?.sandboxOnly === true && environment !== "sandbox") page = <RouteNotFound />;
  else if (!routeAllowed(staticData, can)) page = <RouteNotAllowed />;
  return (
    <Enter keyBy={pathname} className="flex flex-col gap-6">
      {page}
    </Enter>
  );
}
