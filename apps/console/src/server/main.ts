// The console's API half (spec 01 §4.4; spec 02 §2.2): it answers only console.<zone>/api/* and its
// private health, behind the shared front door of @fin/web-host. Its JSON routes are Hono routes at
// basePath("/api"); GET /api/health is the host's own. Saturday's identity lane (L-SAT-06) adds the
// realm's /api/auth allowlist hook and the console's routes through defineApiService's hooks.
import type { ServiceDefinition } from "@fin/server";
import { defineApiService } from "@fin/web-host";

export const consoleService: ServiceDefinition = defineApiService("console");
