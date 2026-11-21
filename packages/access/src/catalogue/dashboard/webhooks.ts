// The dashboard's Webhooks permissions (spec 02 §8.2, [SA-11]). The webhooks area's fragment.
// `webhooks.manage` asks for an intent to create, delete or change an endpoint's URL and a window to
// pause, resume or edit its events; the editor's hint names the stronger kind.
import type { GroupSpec } from "../../engine/types.ts";

export const webhooks = {
  key: "webhooks",
  label: "Webhooks",
  permissions: [
    {
      key: "webhooks.read",
      label: "See endpoints and events",
      description: "Endpoints, deliveries and the events Fin sent.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "webhooks" },
    },
    {
      key: "webhooks.manage",
      label: "Add, change and pause endpoints",
      description: "Where Fin sends events, and which ones.",
      needs: ["webhooks.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "manage webhooks", covers: "webhooks.read" },
    },
    {
      key: "webhooks.roll_secret",
      label: "Roll signing secrets",
      description: "Make a new secret. Fin signs with the old one too for a day.",
      needs: ["webhooks.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "roll signing secrets" },
    },
    {
      key: "webhooks.redeliver",
      label: "Redeliver events",
      description: "Send an event to an endpoint again.",
      needs: ["webhooks.read"],
      stepUp: "window",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "redeliver events" },
    },
  ],
} as const satisfies GroupSpec;
