// Fin Admin's API half (spec 01 §4.4, §7.7; spec 02 §2.2, §10, §14.3): it answers only
// admin.<zone>/api/* and its private health, through the admin tunnel, behind Cloudflare Access at
// the edge and at the connector, and checks the Access token itself on every request before any
// handler (the shared host's step 4). The staff realm answers /api/auth/* behind its allowlist;
// the staff routes are registered from the route policy (policy/), each behind requireStaff.
//
// Everything is built inside `build`, once per process (never at module scope, ARCHITECTURE §1
// principle 14): the pool and unit of work, the staff realm with the staff step-up actions, and
// the staff routes' dependencies.
import { ConfigError } from "@fin/core";
import type { Clock, LineSink } from "@fin/identity";
import { createRealm, readRealmSettings } from "@fin/identity";
import type { ServiceContext, ServiceDefinition } from "@fin/server";
import { loadDocsOrigin } from "@fin/server/config";
import { createStaffDeps, STAFF_ACTIONS } from "@fin/staff";
import { buildApiService } from "@fin/web-host";
import { adminHooks } from "./app.ts";
import { openAdminDatabase } from "./database.mjs";

/**
 * The realm reads its own environment names (development, test, staging, production); the
 * process's `ci` is the realm's `test` (recorded in the pull request until the two agree).
 */
export function realmEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...env, FIN_ENVIRONMENT: env.FIN_ENVIRONMENT === "ci" ? "test" : env.FIN_ENVIRONMENT };
}

/** The service's lines, through its telemetry (scrubbed and shipped after the answer). */
export function telemetryLines(ctx: Pick<ServiceContext, "telemetry">): LineSink {
  return {
    write: (event, level, fields) => ctx.telemetry.log(event, fields, level),
  };
}

export function realmClock(ctx: Pick<ServiceContext, "clock">): Clock {
  return { now: () => new Date(ctx.clock.now()) };
}

/**
 * A refused setting as the process's ConfigError, so the start exits 78 naming the variable and
 * never its value. The realm's and the pool's own errors name their variable in the message.
 */
export function asConfigError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.name !== "RealmConfigError" && error.name !== "DatabaseConfigError") return error;
  let named: string | undefined;
  if ("variable" in error && typeof error.variable === "string") {
    named = error.variable;
  } else {
    // A family of numbered variables (`FIN_LIMIT_KEY_<n>`) is named by its first member.
    const match = /\b((?:FIN|BETTER_AUTH|AUTH)_[A-Z0-9_]*[A-Z0-9])(_<n>)?/.exec(error.message);
    named = match === null ? undefined : `${match[1]}${match[2] === undefined ? "" : "_1"}`;
  }
  const variable = named ?? "FIN_ENVIRONMENT";
  return new ConfigError(
    /^[A-Z][A-Z0-9_]*$/.test(variable) ? variable : "FIN_ENVIRONMENT",
    "malformed",
  );
}

export const adminService: ServiceDefinition = {
  services: ["admin"],
  build(ctx) {
    const clock = realmClock(ctx);
    const lines = telemetryLines(ctx);
    const docsOrigin = loadDocsOrigin(ctx.env, ctx.config.environment);
    let settings: ReturnType<typeof readRealmSettings>;
    let database: ReturnType<typeof openAdminDatabase>;
    try {
      settings = readRealmSettings("staff", realmEnv(ctx.env));
      database = openAdminDatabase({ env: ctx.env, clock, release: ctx.config.release, lines });
    } catch (error) {
      throw asConfigError(error);
    }
    ctx.onStop("database", () => database.close());
    const realm = createRealm({
      settings,
      db: database.db,
      clock,
      lines,
      docsOrigin,
      actions: [STAFF_ACTIONS],
    });
    const deps = createStaffDeps({ realm, clock, lines, environment: settings.environment });
    const built = buildApiService("admin", ctx, adminHooks(deps, docsOrigin));
    return {
      ...built,
      health: async () => ({ ...database.stats(), ...(await database.sampleClock(ctx.clock)) }),
    };
  },
};
