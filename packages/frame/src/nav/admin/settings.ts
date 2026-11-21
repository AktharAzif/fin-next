// Fin Admin's "Settings" group (spec 06 §4.2): Forms, Reasons, Staff and the kill switches. Staff
// is Saturday's (L-SAT-07); the rest appear once their routes exist.
import type { NavItemDef } from "../types.ts";

export const forms: NavItemDef = {
  id: "forms",
  label: "Forms",
  path: "/forms",
  glyph: "FileText",
  needs: ["rfis.read"],
};

/** Shown to every member of staff: read-only without `reasons.manage`. */
export const reasons: NavItemDef = {
  id: "reasons",
  label: "Reasons",
  path: "/reasons",
  glyph: "ListBullets",
};

export const staff: NavItemDef = {
  id: "staff",
  label: "Staff",
  path: "/staff",
  glyph: "UsersThree",
  needs: ["staff.read"],
};

export const killSwitches: NavItemDef = {
  id: "switches",
  label: "Kill switches",
  path: "/switches",
  glyph: "Power",
  needs: ["switches.manage"],
};
