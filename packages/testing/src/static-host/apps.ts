// The static hosts a journey run serves, by host role (spec 01 §7.4), and the test values both the
// static host and an app's test server derive the same way. Real hostnames are never here: a
// journey's browser uses loopback origins, and the deploy reads the real names from configuration.
import { createHash } from "node:crypto";

export type HostRole = "console" | "admin" | "verify" | "selfie" | "docs";

export interface StaticApp {
  readonly role: HostRole;
  /** The app package that builds it. */
  readonly appDir: string;
  /** Its static output, from the repository root. */
  readonly dist: string;
  /** Its `_headers` profile in packages/web-host/src/static/. */
  readonly profile: "app" | "hosted" | "selfie" | "docs";
  /** The loopback port its static host listens on in a journey run. */
  readonly port: number;
  /** The port its API half's test server listens on, when the host has an `/api/` route. */
  readonly apiPort?: number;
  /** Access stands in front of every path (Fin Admin). */
  readonly access: boolean;
}

export const STATIC_APPS: Readonly<Record<HostRole, StaticApp>> = {
  console: {
    role: "console",
    appDir: "apps/console",
    dist: "apps/console/dist/static",
    profile: "app",
    port: 4101,
    apiPort: 4201,
    access: false,
  },
  admin: {
    role: "admin",
    appDir: "apps/admin",
    dist: "apps/admin/dist/static",
    profile: "app",
    port: 4102,
    apiPort: 4202,
    access: true,
  },
  verify: {
    role: "verify",
    appDir: "apps/verify",
    dist: "apps/verify/dist/static/verify",
    profile: "hosted",
    port: 4103,
    apiPort: 4203,
    access: false,
  },
  selfie: {
    role: "selfie",
    appDir: "apps/verify",
    dist: "apps/verify/dist/static/selfie",
    profile: "selfie",
    port: 4104,
    apiPort: 4203,
    access: false,
  },
  docs: {
    role: "docs",
    appDir: "apps/docs",
    dist: "apps/docs/dist/static",
    profile: "docs",
    port: 4105,
    access: false,
  },
};

/** The Access stand-in's port in a journey run. */
export const ACCESS_STAND_IN_PORT = 4110;
/** The email sink's port in a journey run. */
export const EMAIL_SINK_PORT = 4111;

function derive(label: string): string {
  return createHash("sha256").update(`fin-next test value/${label}`).digest("base64url");
}

/**
 * The ingress proof a host's static host sends in a journey run, unless FIN_E2E_INGRESS_PROOF
 * names one. It is a test value, derived so that the app's test server can derive the same one;
 * a `release` image never accepts it (it reads FIN_INGRESS_PROOFS, set only by `pnpm fin`).
 */
export function testIngressProof(role: HostRole, env: NodeJS.ProcessEnv = process.env): string {
  const given = env.FIN_E2E_INGRESS_PROOF;
  return given !== undefined && given !== "" ? given : derive(`ingress-proof/${role}`);
}

/** The AUD tag the Access stand-in signs for in a journey run (a test value, never a real tag). */
export function testAccessAudience(): string {
  return createHash("sha256").update("fin-next test value/access-aud").digest("hex");
}

/** The loopback origin a host is served at in a journey run. */
export function appOrigin(role: HostRole): string {
  return `http://127.0.0.1:${STATIC_APPS[role].port}`;
}
