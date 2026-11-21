// The API keys routes of spec 02 §12.3 (stretch 1, L-SAT-11), on spec 05 §4.6's lifecycle. Every
// route takes `Fin-Organization` and `requireActor`. The guard asks for either key permission
// (`apiKey.sandbox` or `apiKey.live`) to change a key and `apiKey.read` to list; the lifecycle then
// checks the permission of the key's own mode, the maker's role bounding the key, and its own rules,
// before any step-up. Every change takes an intent bound to the action, the key and its fields, and
// the team-change lock, which also serialises the 50-key limit.
import * as z from "zod";
import { pageQuery } from "./schemas.ts";
import { route } from "./types.ts";

const mode = z.enum(["test", "live"]);
const keyName = z.string().max(200);
const scopes = z.array(z.string().max(40)).max(16);
const allowlist = z.array(z.string().max(64)).max(25);

export const KEYS_ROUTES = [
  route({
    id: "keysList",
    method: "GET",
    path: "/keys",
    guard: "requireActor",
    scope: "organization",
    permission: "apiKey.read",
    stepUp: "none",
    assurance: "aal2_or_working",
    body: "none",
    query: pageQuery.extend({ mode: mode.default("test") }),
    limits: [],
    audit: [],
  }),
  route({
    id: "keysCreate",
    method: "POST",
    path: "/keys",
    guard: "requireActor",
    scope: "organization",
    anyOf: ["apiKey.sandbox", "apiKey.live"],
    stepUp: "intent",
    action: "key.create",
    bind: ["name", "mode", "kind", "scopes", "ipAllowlist", "expiresIn"],
    assurance: "aal2_or_working",
    lock: true,
    body: z.strictObject({
      name: keyName,
      mode,
      kind: z.enum(["sk", "rk"]),
      scopes: scopes.default([]),
      ipAllowlist: allowlist.default([]),
      expiresIn: z.enum(["30d", "90d", "1y", "never"]),
    }),
    query: "none",
    limits: ["step_up_intents"],
    audit: ["api_key.created"],
  }),
  route({
    id: "keysUpdate",
    method: "PATCH",
    path: "/keys/:keyId",
    guard: "requireActor",
    scope: "organization",
    anyOf: ["apiKey.sandbox", "apiKey.live"],
    stepUp: "intent",
    action: "key.update",
    bind: ["name", "scopes", "expiresAt", "ipAllowlist"],
    assurance: "aal2_or_working",
    lock: true,
    params: { keyId: "key_id" },
    body: z.strictObject({
      name: keyName.optional(),
      scopes: scopes.optional(),
      expiresAt: z.iso.datetime({ offset: true }).optional(),
      ipAllowlist: allowlist.optional(),
    }),
    query: "none",
    limits: ["step_up_intents"],
    audit: ["api_key.updated"],
  }),
  route({
    id: "keysRoll",
    method: "POST",
    path: "/keys/:keyId/roll",
    guard: "requireActor",
    scope: "organization",
    anyOf: ["apiKey.sandbox", "apiKey.live"],
    stepUp: "intent",
    action: "key.roll",
    bind: ["overlap"],
    assurance: "aal2_or_working",
    lock: true,
    params: { keyId: "key_id" },
    body: z.strictObject({ overlap: z.enum(["now", "1h", "24h"]) }),
    query: "none",
    limits: ["step_up_intents"],
    audit: ["api_key.rolled"],
  }),
  route({
    id: "keysRevoke",
    method: "POST",
    path: "/keys/:keyId/revoke",
    guard: "requireActor",
    scope: "organization",
    anyOf: ["apiKey.sandbox", "apiKey.live"],
    stepUp: "intent",
    action: "key.revoke",
    bind: [],
    assurance: "aal2_or_working",
    lock: true,
    params: { keyId: "key_id" },
    body: "none",
    query: "none",
    limits: ["step_up_intents"],
    audit: ["api_key.revoked"],
  }),
] as const;
