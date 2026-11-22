// "Money movement" (spec 06 §4.2): the customers area (Sunday) and the money area (Monday). Owned by
// those lanes once they add their routes; each item appears only once its route exists.
import type { NavItemDef } from "../types.ts";

export const customers: NavItemDef = {
  id: "customers",
  label: "Customers",
  path: "/customers",
  glyph: "Users",
  needs: ["customers.read"],
};

export const virtualAccounts: NavItemDef = {
  id: "virtual-accounts",
  label: "Virtual accounts",
  path: "/virtual-accounts",
  glyph: "Bank",
  needs: ["customers.read", "money.read"],
};

export const transfers: NavItemDef = {
  id: "transfers",
  label: "Transfers",
  path: "/transfers",
  glyph: "ArrowsLeftRight",
  needs: ["customers.read", "money.read"],
};
