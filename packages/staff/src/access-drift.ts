// The Access drift check (spec 02 §10.1, §10.9, S2-11; T-SAT-38): hourly, the worker reads the
// Allow policies of Fin Admin's Access application with the read-only `FIN_ACCESS_READ_TOKEN`
// (Access: Apps and Policies Read, held by `worker` only) and compares who they let in with the
// `active` and `pending` members (`staff.access_list_view`, the worker's one staff grant). Adding
// staff is two acts in a fixed order (the Access list, then Fin Admin) and removing is the reverse,
// so until both lists agree `admin-access-drift` pages every hour.
//
// The policy may name exact addresses or, as staging's does under the owner's decision of 21 Nov,
// the company's address domain with One-time PIN. A member whose address no Allow rule covers is
// `missing` (they cannot reach Fin Admin); an exact address that is no member's is `extra` (Access
// lets in someone the staff table does not know; `staff.not_listed` catches them per request); a
// rule of any other kind (everyone, a group, an IP range) cannot be compared and counts as `other`.
// Any of the three is drift. The line carries the counts only, never an address (§10.9).
import type { LineSink, Queryable } from "./ports.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const DRIFT_FETCH_TIMEOUT_MS = 10_000;

export interface AccessApplication {
  /** The Cloudflare account's ID (32 hex), from the private overlay at deploy time. */
  accountId: string;
  /** The Access application's ID (a UUID), from the private overlay. */
  appId: string;
  /** FIN_ACCESS_READ_TOKEN. Never logged. */
  token: string;
}

export interface AllowList {
  emails: string[];
  domains: string[];
  /** Include rules of a kind that is neither an address nor an address domain. */
  other: number;
}

export class AccessDriftUnavailable extends Error {
  readonly reason: "config" | "fetch" | "status" | "shape";
  constructor(reason: "config" | "fetch" | "status" | "shape") {
    super(`the Access policies could not be read (${reason})`);
    this.name = "AccessDriftUnavailable";
    this.reason = reason;
  }
}

const ACCOUNT = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Allow policies' include rules, from Cloudflare's `GET .../access/apps/{app}/policies`. */
export function allowListOf(body: unknown): AllowList {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.result)) {
    throw new AccessDriftUnavailable("shape");
  }
  const emails = new Set<string>();
  const domains = new Set<string>();
  let other = 0;
  for (const policy of body.result) {
    if (!isRecord(policy) || policy.decision !== "allow") continue;
    const include = Array.isArray(policy.include) ? policy.include : [];
    for (const rule of include) {
      const email = isRecord(rule) && isRecord(rule.email) ? rule.email.email : undefined;
      const domain =
        isRecord(rule) && isRecord(rule.email_domain) ? rule.email_domain.domain : undefined;
      if (typeof email === "string" && email.includes("@")) {
        emails.add(email.trim().toLowerCase());
      } else if (typeof domain === "string" && DOMAIN.test(domain.trim().toLowerCase())) {
        domains.add(domain.trim().toLowerCase());
      } else {
        other += 1;
      }
    }
  }
  return { emails: [...emails].sort(), domains: [...domains].sort(), other };
}

export interface DriftResult {
  drift: boolean;
  /** Exact addresses the policies name. */
  accessCount: number;
  /** Active and pending members. */
  staffCount: number;
  missing: number;
  extra: number;
  domains: number;
  other: number;
}

export function compareAccess(list: AllowList, staff: readonly string[]): DriftResult {
  const members = new Set(staff.map((e) => e.trim().toLowerCase()));
  const named = new Set(list.emails);
  const covered = (email: string) =>
    named.has(email) || list.domains.includes(email.slice(email.lastIndexOf("@") + 1));
  const missing = [...members].filter((email) => !covered(email)).length;
  const extra = list.emails.filter((email) => !members.has(email)).length;
  return {
    drift: missing > 0 || extra > 0 || list.other > 0,
    accessCount: list.emails.length,
    staffCount: members.size,
    missing,
    extra,
    domains: list.domains.length,
    other: list.other,
  };
}

/** Reads the application's policies from Cloudflare, failing closed on anything unexpected. */
export async function readAllowList(
  app: AccessApplication,
  send: typeof fetch = fetch,
): Promise<AllowList> {
  if (!ACCOUNT.test(app.accountId) || !UUID.test(app.appId) || app.token.length < 20) {
    throw new AccessDriftUnavailable("config");
  }
  let response: Response;
  try {
    response = await send(
      `${CLOUDFLARE_API}/accounts/${app.accountId}/access/apps/${app.appId}/policies?per_page=50`,
      {
        headers: { authorization: `Bearer ${app.token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(DRIFT_FETCH_TIMEOUT_MS),
      },
    );
  } catch {
    throw new AccessDriftUnavailable("fetch");
  }
  if (response.status !== 200) throw new AccessDriftUnavailable("status");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AccessDriftUnavailable("shape");
  }
  return allowListOf(body);
}

/** The members the Access list must let in: `staff.access_list_view` (fin_worker's grant). */
export async function staffAccessList(db: Queryable): Promise<string[]> {
  const result = await db.query<{ email: string }>(
    "SELECT email FROM staff.access_list_view ORDER BY email",
  );
  return result.rows.map((r) => r.email);
}

/**
 * One run of the duty. The policies are read first, outside any unit of work (no database client
 * is held across the call to Cloudflare); then the members. A difference writes `access.drift`
 * with the counts, which pages; a run that cannot read the policies throws, and the duty's own
 * `job.run` line and its success alert (`duty-stalled-access-drift`) report it.
 */
export async function runAccessDriftCheck(deps: {
  readAllowList: () => Promise<AllowList>;
  staffAddresses: () => Promise<string[]>;
  lines: LineSink;
}): Promise<DriftResult> {
  const list = await deps.readAllowList();
  const result = compareAccess(list, await deps.staffAddresses());
  if (result.drift) {
    deps.lines.write("access.drift", "error", {
      accessCount: result.accessCount,
      staffCount: result.staffCount,
      missing: result.missing,
      extra: result.extra,
      domains: result.domains,
      other: result.other,
    });
  }
  return result;
}
