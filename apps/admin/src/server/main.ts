// Fin Admin's API half (spec 01 §4.4, §7.7; spec 02 §2.2, §10.5): it answers only
// admin.<zone>/api/* and its private health, through the admin tunnel, behind Cloudflare Access at
// the edge and at the connector, and checks the Access token itself on every request before any
// handler. Its JSON routes are Hono routes at basePath("/api"). Saturday's staff lane (L-SAT-07)
// adds the staff realm's /api/auth allowlist hook and the routes through defineApiService's hooks.
import type { ServiceDefinition } from "@fin/server";
import { defineApiService } from "@fin/web-host";

export const adminService: ServiceDefinition = defineApiService("admin");
