// What a frame puts in its content area: the page, inside an entrance keyed by the page drawn, or
// the route state its static data calls for. A route whose `needs` the viewer lacks renders
// RouteNotAllowed; a Sandbox-only route renders RouteNotFound in Production ([SA-16], spec 06
// §2.5). The server refuses regardless: this only mirrors it.
//
// The entrance (spec 06 §5.1) is keyed by the presented route, never by the location: a navigation
// moves the location at once while the page being left is still drawn, and keying by it would
// remount that page (losing what was typed) and give the new page no entrance.

import { Enter } from "@fin/motion";
import type { ReactNode } from "react";
import { usePresentedPage } from "../router/matches.ts";
import type { FinStaticData } from "../router/static-data.ts";
import { RouteNotAllowed, RouteNotFound } from "../states/RouteStates.tsx";

export function routeAllowed(
  staticData: FinStaticData | null,
  can: (permission: string) => boolean,
): boolean {
  return (staticData?.needs ?? []).every((permission) => can(permission));
}

export function FrameContent({
  staticData,
  can,
  environment,
  children,
}: {
  staticData: FinStaticData | null;
  can: (permission: string) => boolean;
  environment: "sandbox" | "production";
  children: ReactNode;
}) {
  const presented = usePresentedPage();
  let page = children;
  if (staticData?.sandboxOnly === true && environment !== "sandbox") page = <RouteNotFound />;
  else if (!routeAllowed(staticData, can)) page = <RouteNotAllowed />;
  return (
    <Enter keyBy={presented} className="flex flex-col gap-6">
      {page}
    </Enter>
  );
}
