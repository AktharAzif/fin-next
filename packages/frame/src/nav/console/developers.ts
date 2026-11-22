// "Developers" (spec 06 §4.2): API keys, Webhooks, Events and the Sandbox-only Simulator.
import type { NavItemDef } from "../types.ts";

export const apiKeys: NavItemDef = {
  id: "api-keys",
  label: "API keys",
  path: "/developers/keys",
  glyph: "Key",
  needs: ["apiKey.read"],
};

export const webhooks: NavItemDef = {
  id: "webhooks",
  label: "Webhooks",
  path: "/developers/webhooks",
  glyph: "WebhooksLogo",
  needs: ["webhooks.read"],
};

export const events: NavItemDef = {
  id: "events",
  label: "Events",
  path: "/developers/events",
  glyph: "ListBullets",
  needs: ["webhooks.read"],
};

export const simulator: NavItemDef = {
  id: "simulator",
  label: "Simulator",
  path: "/developers/simulator",
  glyph: "Flask",
  needs: ["simulator.use", "customers.read"],
  sandboxOnly: true,
};
