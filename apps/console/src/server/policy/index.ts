// The console's route policy, assembled from its fragments (spec 02 §14.1). The router registers
// exactly these routes; nothing else under /api answers but /api/health and the realm's allowlist.
// API keys (§12, stretch 1) are the keys area's fragment (L-SAT-11).
import { IDENTITY_ROUTES } from "./identity.ts";
import { KEYS_ROUTES } from "./keys.ts";
import { ORGS_ROUTES } from "./orgs.ts";
import type { RoutePolicy } from "./types.ts";

export const CONSOLE_POLICY: readonly RoutePolicy[] = [
  ...IDENTITY_ROUTES,
  ...ORGS_ROUTES,
  ...KEYS_ROUTES,
];

export type RouteId =
  | (typeof IDENTITY_ROUTES)[number]["id"]
  | (typeof ORGS_ROUTES)[number]["id"]
  | (typeof KEYS_ROUTES)[number]["id"];

export type { Guard, Method, RoutePolicy, Scope, StepUpKind } from "./types.ts";
