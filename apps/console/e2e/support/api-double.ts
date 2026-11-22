// A scripted stand-in for the console's API half, for the screen specs: the built app runs on the
// harness's static host under the production page policy, and the page's `/api/*` calls are
// answered here, in the browser's routing, so each board state can be drawn on demand (a slow
// answer, a refusal, a step-up). It records every request, so a spec can assert what the client
// sent (X-Fin-App, Fin-Step-Up-Intent, Idempotency-Key, the body). It stands in for nothing a
// journey proves: the journeys in journeys.spec.ts run against the real API test server.
import { dashboardCatalogue } from "@fin/access";
import type { Page, Request, Route } from "@playwright/test";
import { E2E_RELEASE } from "./artefacts.ts";

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  /** Milliseconds before the answer, to draw a loading state. */
  readonly delayMs?: number;
  /** Abort the request as a network failure ("Couldn't reach Fin"). */
  readonly fail?: boolean;
}

export type Handler = (request: Recorded, nth: number) => Reply | Promise<Reply>;

export const ok = (body: unknown = {}): Reply => ({ status: 200, body });
export const noContent = (): Reply => ({ status: 204 });

export function problem(status: number, code: string, extra: Record<string, unknown> = {}): Reply {
  return {
    status,
    body: {
      type: `https://docs.localhost:4105/errors/${code}`,
      title: code,
      status,
      code,
      request_id: "req_e2e",
      ...extra,
    },
  };
}

/** The library's own error body (`{ code, message }`, application/json). */
export function libraryError(status: number, code: string): Reply {
  return { status, body: { library: true, code, message: code } };
}

export function stepUpRequired(
  reasonKey: string,
  options: { intentId?: string; kind?: "intent" | "window"; methods?: string[] } = {},
): Reply {
  const kind = options.kind ?? "intent";
  return problem(403, "step_up_required", {
    step_up_kind: kind,
    ...(kind === "intent" ? { intent_id: options.intentId ?? "sti_e2e" } : {}),
    methods: options.methods ?? ["authenticator", "backup_code"],
    reason_key: reasonKey,
    expires_at: "2026-11-21T12:05:00Z",
  });
}

interface Entry {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: Handler;
  count: number;
}

function patternOf(path: string): RegExp {
  const escaped = path
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${escaped}$`);
}

function readBody(request: Request): unknown {
  const text = request.postData();
  if (text === null || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ApiDouble {
  readonly requests: Recorded[] = [];
  readonly unhandled: string[] = [];
  private readonly entries: Entry[] = [];

  /** Answers `METHOD /api/path` (`:param` segments match one segment); the newest rule wins. */
  on(key: string, handler: Handler | Reply): this {
    const [method = "GET", path = "/"] = key.split(" ");
    this.entries.unshift({
      method,
      pattern: patternOf(path),
      handler: typeof handler === "function" ? handler : () => handler,
      count: 0,
    });
    return this;
  }

  /** The recorded requests for `METHOD /api/path`. */
  calls(key: string): Recorded[] {
    const [method = "GET", path = "/"] = key.split(" ");
    const pattern = patternOf(path);
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }

  async install(page: Page): Promise<void> {
    await page.route(
      (url) => url.pathname === "/api" || url.pathname.startsWith("/api/"),
      (route) => this.answer(route),
    );
  }

  private async answer(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const recorded: Recorded = {
      method: request.method(),
      path: url.pathname,
      search: url.searchParams,
      headers: await request.allHeaders(),
      body: readBody(request),
    };
    this.requests.push(recorded);
    if (recorded.path === "/api/monitoring/csp") {
      await route.fulfill({ status: 204, headers: { "cache-control": "no-store" } });
      return;
    }
    const entry = this.entries.find(
      (e) => e.method === recorded.method && e.pattern.test(recorded.path),
    );
    if (entry === undefined) this.unhandled.push(`${recorded.method} ${recorded.path}`);
    const reply =
      entry === undefined
        ? problem(404, "not_found")
        : await entry.handler(recorded, entry.count++);
    if (reply.delayMs !== undefined) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (reply.fail === true) {
      await route.abort("connectionfailed");
      return;
    }
    const status = reply.status ?? 200;
    const library =
      typeof reply.body === "object" && reply.body !== null && "library" in reply.body;
    const body =
      library && typeof reply.body === "object" && reply.body !== null
        ? Object.fromEntries(Object.entries(reply.body).filter(([key]) => key !== "library"))
        : reply.body;
    await route.fulfill({
      status,
      headers: {
        "content-type": status >= 400 && !library ? "application/problem+json" : "application/json",
        "cache-control": "no-store",
        "fin-release": E2E_RELEASE,
      },
      ...(status === 204 || body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

const ALL = [...dashboardCatalogue.keys];
const ADMIN = ALL.filter((key) => key !== "organization.delete" && key !== "golive.submit");

export const ORG = {
  orgId: "org_acme",
  name: "Acme Remit",
  roleKey: "super_admin",
  roleLabel: "Super admin",
  roleKnown: true,
  liveStatus: "sandbox",
};

/** A signed-in viewer (spec 02 §14.4), Maya Rivera, Super admin of Acme Remit by default. */
export function viewer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gate: "ok",
    user: { id: "usr_maya", name: "Maya Rivera", email: "maya@example.com" },
    assurance: "aal2",
    factors: { passkeys: 1, authenticator: true, backupCodesLeft: 10 },
    canSkipProtect: false,
    canTrustBrowser: false,
    memberships: [ORG],
    currentOrgId: ORG.orgId,
    permissions: ALL,
    invitations: [],
    ...overrides,
  };
}

/** Daniel Okoye, an Admin: everything but deleting the organisation and sending the request. */
export function adminViewer(): Record<string, unknown> {
  return viewer({
    user: { id: "usr_daniel", name: "Daniel Okoye", email: "daniel@example.com" },
    memberships: [{ ...ORG, roleKey: "admin", roleLabel: "Admin" }],
    permissions: ADMIN,
  });
}

/** Priya Shah, a Developer: reads the team, keys and webhooks, changes nothing on the team. */
export function developerViewer(): Record<string, unknown> {
  return viewer({
    user: { id: "usr_priya", name: "Priya Shah", email: "priya@example.com" },
    memberships: [{ ...ORG, roleKey: "rol_dev", roleLabel: "Developer" }],
    permissions: ["member.read", "apiKey.read", "webhooks.read", "customers.read"],
  });
}

export const FACTOR_STEP = {
  gate: "factor_step",
  email: "maya@example.com",
  methods: ["authenticator", "backup_code"],
};

export const BUILT_IN_ROLES = [
  {
    roleKey: "super_admin",
    roleId: null,
    label: "Super admin",
    description: null,
    builtIn: true,
    permissionCount: ALL.length,
    holders: 1,
    holderIds: ["mem_maya"],
    permissions: ALL,
  },
  {
    roleKey: "admin",
    roleId: null,
    label: "Admin",
    description: null,
    builtIn: true,
    permissionCount: ADMIN.length,
    holders: 1,
    holderIds: ["mem_admin"],
    permissions: ADMIN,
  },
];

export const DEVELOPER_ROLE = {
  roleKey: "rol_dev",
  roleId: "rol_dev",
  label: "Developer",
  description: "Builds and tests the integration in Sandbox.",
  builtIn: false,
  permissionCount: 4,
  holders: 2,
  holderIds: ["mem_dev_1", "mem_dev_2"],
  invitations: 0,
  permissions: ["member.read", "apiKey.read", "webhooks.read", "customers.read"],
};
