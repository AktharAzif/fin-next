// Document titles (spec 06 §2.5, S6-07), from the route's `pageName`, never from a record's name:
// the console in Sandbox "Sandbox · {page} · Fin", in Production "{page} · Fin"; signed-out pages
// "{page} · Fin"; Fin Admin "{page} · Fin Admin"; verify "{page} · Fin" until spec 03 says more.
import type { AppName } from "@fin/app-contracts";
import type { FrameKind } from "./static-data.ts";

export interface TitleInput {
  app: AppName;
  frame: FrameKind;
  pageName: string;
  /** The console's environment; ignored elsewhere. */
  environment?: "sandbox" | "production";
}

export function documentTitle({ app, frame, pageName, environment }: TitleInput): string {
  if (app === "admin") return `${pageName} · Fin Admin`;
  if (app === "console" && frame === "app" && environment !== "production") {
    return `Sandbox · ${pageName} · Fin`;
  }
  return `${pageName} · Fin`;
}
