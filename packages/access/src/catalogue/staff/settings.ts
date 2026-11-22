// Fin Admin's Settings permissions (spec 02 §8.3, [SA-12]). The staff settings area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const settings = {
  key: "settings",
  label: "Settings",
  permissions: [
    {
      key: "forms.manage",
      label: "Manage forms",
      description: "Edit, publish and archive request forms.",
      needs: ["rfis.read"],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "manage forms" },
    },
    {
      key: "reasons.manage",
      label: "Manage reasons",
      description: "The preset reasons staff give.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "manage reasons" },
    },
    {
      key: "templates.manage",
      label: "Manage message templates",
      description: "What staff send to developers and customers.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "manage message templates" },
    },
    {
      key: "views.manage",
      label: "Manage shared views",
      description: "Save and delete views every member of staff sees.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "manage shared views" },
    },
  ],
} as const satisfies GroupSpec;
