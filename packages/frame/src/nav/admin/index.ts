// Fin Admin's sidebar (spec 06 §4.2, BRIEF §5 and §11): the review lists, then the Settings group.
// No footer items: the Sidebar draws its empty footer rule. The fragments belong to their areas'
// lanes; this assembler to the UI kit lane.
import type { NavTreeDef } from "../types.ts";
import {
  adminAuditLog,
  adminCustomers,
  customerApprovals,
  money,
  organisations,
  productionAccess,
  requestsForInformation,
} from "./review.ts";
import { forms, killSwitches, reasons, staff } from "./settings.ts";

export const adminNav: NavTreeDef = {
  groups: [
    {
      id: "admin",
      items: [
        productionAccess,
        customerApprovals,
        organisations,
        adminCustomers,
        requestsForInformation,
        money,
        adminAuditLog,
      ],
    },
    { id: "settings", label: "Settings", items: [forms, reasons, staff, killSwitches] },
  ],
  footer: [],
};
