// What every route declares (spec 06 §2.5, S6-01): which frame draws it, which sidebar item is
// current, the page's name for the title, and what the viewer needs. FrameSwitch reads the deepest
// match's value, so lane folders keep EXECUTION's paths with no pathless layout folder.

export type FrameKind = "app" | "auth" | "bare";

export interface FinStaticData {
  frame: FrameKind;
  /** The sidebar item this page sits under, or null (Account security, a redirect). */
  navId: string | null;
  /** The page's name for the document title; never a record's name (S6-07). */
  pageName: string;
  /** Permissions the page needs; the page renders RouteNotAllowed without them. */
  needs?: readonly string[];
  /** Renders RouteNotFound in Production (the Simulator). */
  sandboxOnly?: boolean;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption extends Partial<FinStaticData> {}
}

const FRAMES: readonly FrameKind[] = ["app", "auth", "bare"];

/** The Fin fields of a match's static data, or null when the route declares none. */
export function readStaticData(value: unknown): FinStaticData | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const frame = record.frame;
  const pageName = record.pageName;
  const navId = record.navId;
  if (typeof frame !== "string" || !(FRAMES as readonly string[]).includes(frame)) return null;
  if (typeof pageName !== "string" || pageName === "") return null;
  if (navId !== null && typeof navId !== "string") return null;
  const data: FinStaticData = { frame: frame as FrameKind, navId, pageName };
  if (Array.isArray(record.needs) && record.needs.every((p) => typeof p === "string")) {
    data.needs = record.needs as string[];
  }
  if (record.sandboxOnly === true) data.sandboxOnly = true;
  return data;
}
