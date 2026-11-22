// The console's sidebar (spec 06 §4.2, BRIEF §5 Option A, round 2): Home; Money movement; Developers;
// the pinned footer. The fragments belong to their areas' lanes; this assembler to the UI kit lane.
import type { NavTreeDef } from "../types.ts";
import { apiKeys, events, simulator, webhooks } from "./developers.ts";
import { apiDocs, auditLog, settings } from "./footer.ts";
import { home } from "./home.ts";
import { customers, transfers, virtualAccounts } from "./money.ts";

export const consoleNav: NavTreeDef = {
  groups: [
    { id: "home", items: [home] },
    { id: "money", label: "Money movement", items: [customers, virtualAccounts, transfers] },
    { id: "developers", label: "Developers", items: [apiKeys, webhooks, events, simulator] },
  ],
  footer: [auditLog, settings, apiDocs],
};
