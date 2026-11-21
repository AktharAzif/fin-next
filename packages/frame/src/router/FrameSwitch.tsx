// The root's frame choice (spec 06 §2.5, S6-01): the deepest drawn match's `staticData.frame` picks
// AppFrame (or AdminFrame), AuthFrame or nothing. A path no route matches, a path below a route
// included, has no static data, so it takes the app's fallback frame: the console and Fin Admin
// draw their not-found page inside the signed-in frame, verify inside AuthFrame.
import type { ComponentType, ReactNode } from "react";
import { useRouteStaticData } from "./matches.ts";
import type { FrameKind } from "./static-data.ts";

export interface FrameSwitchProps {
  frames: {
    app?: ComponentType<{ children: ReactNode }>;
    auth?: ComponentType<{ children: ReactNode }>;
  };
  fallback: FrameKind;
  children: ReactNode;
}

export function FrameSwitch({ frames, fallback, children }: FrameSwitchProps) {
  const kind = useRouteStaticData()?.frame ?? fallback;
  const Frame = kind === "app" ? frames.app : kind === "auth" ? frames.auth : undefined;
  return Frame === undefined ? children : <Frame>{children}</Frame>;
}
