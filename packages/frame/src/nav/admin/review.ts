// Fin Admin's review lists (spec 06 §4.2, §7.2): Sunday's screens (L-SUN-08), the money view
// (Monday, L-MON-07) and the audit log (Sunday spill). Each appears once its route exists.
import type { NavItemDef } from "../types.ts";

export const productionAccess: NavItemDef = {
  id: "golive",
  label: "Production access",
  path: "/go-live",
  glyph: "Rocket",
  needs: ["golive.read"],
};

export const customerApprovals: NavItemDef = {
  id: "approvals",
  label: "Customer approvals",
  path: "/approvals",
  glyph: "ListChecks",
  needs: ["customers.read"],
};

export const organisations: NavItemDef = {
  id: "organisations",
  label: "Organisations",
  path: "/organisations",
  glyph: "Buildings",
  needs: ["organisations.read"],
};

export const adminCustomers: NavItemDef = {
  id: "customers",
  label: "Customers",
  path: "/customers",
  glyph: "Users",
  needs: ["customers.read"],
};

export const requestsForInformation: NavItemDef = {
  id: "rfis",
  label: "Requests for information",
  path: "/rfis",
  glyph: "ChatCircleText",
  needs: ["rfis.read"],
};

export const money: NavItemDef = {
  id: "money",
  label: "Money",
  path: "/money/transfers",
  glyph: "Bank",
  needs: ["money.read"],
};

export const adminAuditLog: NavItemDef = {
  id: "audit",
  label: "Audit log",
  path: "/audit",
  glyph: "ClockCounterClockwise",
  needs: ["audit.read"],
};
