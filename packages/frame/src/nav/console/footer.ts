// The console's pinned footer (spec 06 §4.2, round 2): Audit log above Settings, then API docs.
import type { NavItemDef } from "../types.ts";

export const auditLog: NavItemDef = {
  id: "audit-log",
  label: "Audit log",
  path: "/audit-log",
  glyph: "ClockCounterClockwise",
  needs: ["auditLog.read"],
};

export const settings: NavItemDef = {
  id: "settings",
  label: "Settings",
  path: "/settings/organisation",
  glyph: "GearSix",
};

export const apiDocs: NavItemDef = {
  id: "api-docs",
  label: "API docs",
  path: "/",
  glyph: "BookOpen",
  external: "docs",
};
