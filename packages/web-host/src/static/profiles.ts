// The `_headers` profiles of the static hosts (spec 01 §7.4; ARCHITECTURE §5.16, §7.12; [SA-45]).
// A control path: every change needs the owner's approval. Node built-ins and relative imports only
// (none are needed here), so the deploy job renders them with no install.
//
// | Profile | Outputs          | Differs from `app`                                                |
// | app     | console, admin   | (the base)                                                        |
// | hosted  | verify           | Referrer-Policy no-referrer; Permissions-Policy denies passkeys too |
// | selfie  | selfie           | as hosted until SP-11 lists Sumsub's hosts (Sunday, [SA-26])     |
// | docs    | docs             | connect-src adds the API origin for Try it; form-action 'none'; no |
// |         |                  | report-to and no Reporting-Endpoints; as hosted otherwise          |
//
// The docs exception ([SA-45]: style-src 'unsafe-inline' and img-src data: for Scalar) is added only
// by the pull request that records the owner's yes in [AP-11]; until then 'self' alone. FW-X7's
// fallback, if FW-S1 fails, would change style-src to 'self' 'unsafe-inline' in every profile.

export type ProfileName = "app" | "hosted" | "selfie" | "docs";
export type StaticOutput = "console" | "admin" | "verify" | "selfie" | "docs";

export const OUTPUT_PROFILE: Readonly<Record<StaticOutput, ProfileName>> = Object.freeze({
  console: "app",
  admin: "app",
  verify: "hosted",
  selfie: "selfie",
  docs: "docs",
});

/** Each output's host role, the key of its hostname in the deploy's host map. */
export const OUTPUT_ROLE: Readonly<Record<StaticOutput, string>> = Object.freeze({
  console: "console",
  admin: "admin",
  verify: "verify",
  selfie: "selfie",
  docs: "docs",
});

const DENY_FEATURES = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
];

export const PERMISSIONS_APP = [
  ...DENY_FEATURES,
  "publickey-credentials-get=(self)",
  "publickey-credentials-create=(self)",
].join(", ");

export const PERMISSIONS_DENY_ALL = [
  ...DENY_FEATURES,
  "publickey-credentials-get=()",
  "publickey-credentials-create=()",
].join(", ");

export interface Profile {
  /** The page policy's directives, in order; `{api}` stands for the API origin. */
  csp: readonly (readonly [string, string])[];
  /** Whether the policy reports to `/api/monitoring/csp` (the docs host has no /api/). */
  reports: boolean;
  referrerPolicy: "same-origin" | "no-referrer";
  permissionsPolicy: string;
}

const BASE_CSP: readonly (readonly [string, string])[] = [
  ["default-src", "'none'"],
  ["script-src", "'self'"],
  ["style-src", "'self'"],
  ["img-src", "'self'"],
  ["font-src", "'self'"],
  ["connect-src", "'self'"],
  ["manifest-src", "'self'"],
  ["worker-src", "'none'"],
  ["frame-src", "'none'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'self'"],
  ["frame-ancestors", "'none'"],
];

function withDirective(
  csp: readonly (readonly [string, string])[],
  name: string,
  value: string,
): (readonly [string, string])[] {
  return csp.map(
    ([directive, current]) => [directive, directive === name ? value : current] as const,
  );
}

export const PROFILES: Readonly<Record<ProfileName, Profile>> = Object.freeze({
  app: {
    csp: BASE_CSP,
    reports: true,
    referrerPolicy: "same-origin",
    permissionsPolicy: PERMISSIONS_APP,
  },
  hosted: {
    csp: BASE_CSP,
    reports: true,
    referrerPolicy: "no-referrer",
    permissionsPolicy: PERMISSIONS_DENY_ALL,
  },
  selfie: {
    csp: BASE_CSP,
    reports: true,
    referrerPolicy: "no-referrer",
    permissionsPolicy: PERMISSIONS_DENY_ALL,
  },
  docs: {
    csp: withDirective(
      withDirective(BASE_CSP, "connect-src", "'self' {api}"),
      "form-action",
      "'none'",
    ),
    reports: false,
    referrerPolicy: "no-referrer",
    permissionsPolicy: PERMISSIONS_DENY_ALL,
  },
});

export const ASSET_CACHE = "public, max-age=31536000, immutable";
export const REPORTING_ENDPOINTS = 'csp="/api/monitoring/csp"';
