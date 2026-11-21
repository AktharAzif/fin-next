// AdminAudit (spec 06 §7.2, §8.4: all 12 states; spec 02 §14.3, §14.5, §16.4): Fin Admin's audit
// log on the built app behind the Access stand-in. The board's states are drawn from answers the
// page asks for (`page.route`), so each is exact: the list newest first, the drawer stepping
// through the page and an entry with nothing changed, My actions and Rejections this week, the
// filters as chips and the no-results state, the first use with no toolbar, loading and failed,
// the drawer's loading and failed states from a link to an entry, and no permission. One journey
// runs against the admin API stand-in: the first Admin's enrolment lands on the log, which shows it.
import { expect, test } from "@fin/testing/playwright";
import type { Page, Request, Route } from "@playwright/test";
import {
  emailedCodeSignIn,
  enrol,
  hold,
  inApp,
  ORIGIN,
  server,
  throughAccess,
} from "../support/journey.ts";

// IDs and addresses are built at run time (fixtures use example.com only).
const id = (prefix: string, n: number) => `${prefix}_01jd${String(n).padStart(22, "0")}`;
const aud = (n: number) => id("aud", n);
const NADIA = { id: id("stf", 1), email: ["nadia.brooks", "example.com"].join("@") };
const OWEN = { id: id("stf", 2), email: ["owen.price", "example.com"].join("@") };
const RAVI = { id: id("stf", 3), email: ["ravi.kapoor", "example.com"].join("@") };
const HARBOUR = id("org", 7);

function viewer(permissions: string[]) {
  return {
    state: "ok",
    staff: { id: NADIA.id, email: NADIA.email, roleKey: "admin", roleLabel: "Admin" },
    permissions,
    environment: "staging",
  };
}

type Entry = Record<string, unknown> & { id: string; event: string };

function entry(
  n: number,
  event: string,
  who: { id: string; email: string } | "operator",
  at: string,
  extra: {
    target?: { id: string; label: string | null };
    metadata?: Record<string, unknown>;
    org?: string;
  } = {},
): Entry {
  return {
    id: aud(n),
    event,
    category: "staff",
    at,
    actor:
      who === "operator"
        ? { kind: "operator", id: "run_bootstrap", via: "operator", email: null, name: null }
        : { kind: "staff", id: who.id, via: "admin", email: who.email, name: null },
    target: extra.target ?? { id: id("cus", n), label: null },
    refs: [],
    organisationId: extra.org ?? null,
    metadata: extra.metadata ?? {},
    verification: who === "operator" ? null : "passkey",
    address: who === "operator" ? null : "2001:db8::42",
    device: who === "operator" ? null : "Chrome on Mac",
  };
}

// Newest first, as the board draws them.
const ROWS: Entry[] = [
  entry(8, "staff.member_added", NADIA, "2026-11-19T16:20:31.000Z", {
    target: { id: RAVI.id, label: RAVI.email },
    metadata: { roleKey: "viewer", reactivated: false },
  }),
  entry(7, "staff.document_viewed", OWEN, "2026-11-19T10:12:05.000Z", { org: HARBOUR }),
  entry(6, "staff.rfi_created", OWEN, "2026-11-18T09:30:12.000Z", {
    org: HARBOUR,
    metadata: { reasonCode: "source_of_funds" },
  }),
  entry(5, "staff.organization_paused", NADIA, "2026-11-17T15:02:44.000Z", {
    target: { id: HARBOUR, label: null },
    org: HARBOUR,
    metadata: { reasonCode: "risk_review", fromStatus: "live", toStatus: "paused" },
  }),
  entry(4, "staff.customer_rejected", OWEN, "2026-11-13T16:40:18.000Z", {
    org: HARBOUR,
    metadata: { reasonCode: "documents_mismatch" },
  }),
  entry(3, "staff.role_changed", NADIA, "2026-11-06T14:10:02.000Z", {
    target: { id: OWEN.id, label: OWEN.email },
    metadata: { fromRole: "viewer", toRole: "compliance", reason: "changed", lowered: false },
  }),
  entry(2, "switch.set", NADIA, "2026-11-04T12:00:40.000Z", {
    target: { id: "signups", label: null },
    metadata: { reasonCode: "drill" },
  }),
  entry(1, "staff.bootstrapped", "operator", "2026-10-08T10:20:55.000Z", {
    target: { id: NADIA.id, label: NADIA.email },
    metadata: { reset: false, reasonCode: "first_admin" },
  }),
];

function pageOf(items: Entry[], more: Partial<Record<string, unknown>> = {}) {
  return {
    items,
    total: items.length,
    totalCapped: false,
    nextCursor: null,
    previousCursor: null,
    people: [
      { id: NADIA.id, email: NADIA.email },
      { id: OWEN.id, email: OWEN.email },
      { id: RAVI.id, email: RAVI.email },
    ],
    ...more,
  };
}

function json(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      headers: {
        "content-type": status >= 400 ? "application/problem+json" : "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(body),
    });
}

function problem(status: number, code: string) {
  return json(
    {
      type: `https://docs.localhost/errors/${code}`,
      title: code,
      status,
      code,
      request_id: "req_e2e_audit",
    },
    status,
  );
}

/** The list's requests, by their query, as the page sent them. */
function listRequests(page: Page): URLSearchParams[] {
  const seen: URLSearchParams[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/audit") seen.push(url.searchParams);
  });
  return seen;
}

/** The viewer and a list answer chosen per request (by its query). */
async function stub(
  page: Page,
  answer: (query: URLSearchParams) => unknown,
  permissions = ["audit.read", "staff.read"],
) {
  await page.route("**/api/viewer", json(viewer(permissions)));
  await page.route("**/api/audit?*", (route) =>
    json(answer(new URL(route.request().url()).searchParams))(route),
  );
}

function rows(page: Page) {
  return page.locator("tbody tr[data-row-id]");
}

function drawer(page: Page) {
  return page.getByRole("dialog");
}

/** Waits until every menu has finished closing (a menu opened while one leaves closes again). */
async function menusGone(page: Page): Promise<void> {
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test("@journey the log lists staff actions newest first; a row opens its entry and steps through the page", async ({
  page,
}) => {
  const requests = listRequests(page);
  await stub(page, () => pageOf(ROWS));
  await throughAccess(page, NADIA.email, "/audit");
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Audit log", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    inApp(page).getByText("Everything Fin’s staff have done here, newest first."),
  ).toBeVisible();

  // list: What (and the target under it), Who, Organisation, Reason, When (UTC).
  await expect(rows(page)).toHaveCount(8);
  await expect(rows(page).first()).toHaveAccessibleName(
    `Added a member of staff, ${RAVI.email}, ${NADIA.email}, 19 Nov 2026, 16:20:31 UTC`,
  );
  const paused = rows(page).nth(3);
  await expect(paused).toContainText("Paused Production access");
  await expect(paused).toContainText("Risk review");
  await expect(paused).toContainText("risk_review");
  await expect(paused).toContainText("17 Nov 2026, 15:02:44");
  await expect(rows(page).nth(7)).toContainText("Operator");
  await expect(rows(page).nth(7)).toContainText("Made the first Admin");
  await expect(rows(page).first()).toContainText("No reason asked");
  await expect(inApp(page).getByText("8 staff actions")).toBeVisible();
  expect(requests.at(-1)?.get("limit")).toBe("50");

  // drawer: the row opens its entry, with what changed.
  await paused.click();
  await expect(page).toHaveURL(new RegExp(`[?&]view=${aud(5)}`));
  const panel = drawer(page);
  await expect(panel.getByRole("heading", { name: "Paused Production access" })).toBeVisible();
  await expect(panel.getByText("4 of 8")).toBeVisible();
  await expect(panel.getByText("staff.organization_paused")).toBeVisible();
  await expect(panel.getByText("17 November 2026, 15:02:44 UTC")).toBeVisible();
  await expect(panel.getByText("Passkey")).toBeVisible();
  await expect(panel.getByText("2001:db8::42 · Chrome on Mac")).toBeVisible();
  await expect(panel.getByText("Status:")).toBeVisible();
  await expect(panel.getByText("Live → Paused", { exact: false })).toBeVisible();

  // drawerNoChange: the next row up has nothing changed.
  await panel.getByRole("button", { name: "Previous staff action" }).click();
  await expect(panel.getByRole("heading", { name: "Asked for information" })).toBeVisible();
  await panel.getByRole("button", { name: "Previous staff action" }).click();
  await expect(panel.getByRole("heading", { name: "Viewed a document" })).toBeVisible();
  await expect(
    panel.getByText("Nothing changed, or this action is from before Fin kept what changed."),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]view=${aud(7)}`));

  // Opening and stepping read no list again; closing goes back to the list.
  expect(requests).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(`${ORIGIN}/audit`);
  expect(requests).toHaveLength(1);
});

test("@journey My actions and Rejections this week ask for their view, and an empty view says why", async ({
  page,
}) => {
  const requests = listRequests(page);
  await stub(page, (query) => {
    if (query.get("show") === "mine") {
      return pageOf(ROWS.filter((row) => (row.actor as { id: string }).id === NADIA.id));
    }
    if (query.get("show") === "rejections") return pageOf([]);
    return pageOf(ROWS);
  });
  await throughAccess(page, NADIA.email, "/audit");
  await expect(rows(page)).toHaveCount(8);
  const views = page.getByRole("group", { name: "Views" });
  await expect(views.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");

  // mine
  await views.getByRole("button", { name: "My actions" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/audit?show=mine`);
  await expect(rows(page)).toHaveCount(4);
  expect(requests.at(-1)?.get("show")).toBe("mine");
  await expect(views.getByRole("button", { name: "My actions" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // rejections
  await views.getByRole("button", { name: "Rejections this week" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/audit?show=rejections`);
  await expect(inApp(page).getByText("No rejections this week")).toBeVisible();
  await expect(
    inApp(page).getByText("Nobody here has rejected a customer since Monday."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show every action" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/audit`);
  await expect(rows(page)).toHaveCount(8);
  expect(requests.at(-1)?.get("show")).toBeNull();
});

test("@journey filters live in the URL as chips, and filters matching nothing offer to clear them", async ({
  page,
}) => {
  const requests = listRequests(page);
  await stub(page, (query) => {
    if (query.get("actor") !== null) return pageOf([]);
    const actions = query.get("action")?.split(",") ?? null;
    return pageOf(actions === null ? ROWS : ROWS.filter((row) => actions.includes(row.event)));
  });
  await throughAccess(page, NADIA.email, "/audit");
  await expect(rows(page)).toHaveCount(8);

  // filtered: two actions and a date. Like a person, each menu is opened once the last has gone.
  await page.getByRole("button", { name: "Action", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rejected a customer" }).click();
  await expect(rows(page)).toHaveCount(1);
  await menusGone(page);
  await page.getByRole("button", { name: "Action (1)" }).click();
  await page.getByRole("menuitem", { name: "Paused Production access" }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(requests.at(-1)?.get("action")).toBe("staff.customer_rejected,staff.organization_paused");
  await menusGone(page);
  await page.getByRole("button", { name: "Date", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Last 30 days" }).click();
  await expect(page).toHaveURL(/date=30d/);
  await expect(page.getByRole("button", { name: "Date (1)" })).toBeVisible();
  expect(requests.at(-1)?.get("date")).toBe("30d");
  await menusGone(page);
  await expect(
    page.getByRole("button", {
      name: "Remove filter: Action: Rejected a customer, Paused Production access",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove filter: Date: Last 30 days" }),
  ).toBeVisible();

  // noResults: a member of staff who did none of it.
  await page.getByRole("button", { name: "Staff member", exact: true }).click();
  await page.getByRole("menuitem", { name: RAVI.email }).click();
  await expect(inApp(page).getByText("No staff actions match these filters")).toBeVisible();
  expect(requests.at(-1)?.get("actor")).toBe(RAVI.id);
  await expect(inApp(page).getByText(`Staff member: ${RAVI.email}`).first()).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(page).toHaveURL(`${ORIGIN}/audit`);
  await expect(rows(page)).toHaveCount(8);

  // A filter's chip takes that filter away.
  await page.goto("/audit?action=switch.set&date=7d");
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Remove filter: Date: Last 7 days" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/audit?action=switch.set`);
});

test("@journey before any staff action the log says so, with nothing to filter", async ({
  page,
}) => {
  await stub(page, () => pageOf([], { people: [] }));
  await throughAccess(page, NADIA.email, "/audit");
  await expect(inApp(page).getByText("No staff actions yet")).toBeVisible();
  await expect(
    inApp(page).getByText("Everything Fin’s staff do here appears in this log."),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Views" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy link" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Pagination" })).toHaveCount(0);
});

test("@journey a log that fails keeps its header and offers Try again", async ({ page }) => {
  let fail = true;
  await page.route("**/api/viewer", json(viewer(["audit.read", "staff.read"])));
  await page.route("**/api/audit?*", (route) =>
    fail ? problem(500, "internal")(route) : json(pageOf(ROWS))(route),
  );
  await throughAccess(page, NADIA.email, "/audit");
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await expect(inApp(page).getByText("Couldn’t load the audit log")).toBeVisible();
  await expect(
    inApp(page).getByText("Something went wrong on our side. Nothing was changed."),
  ).toBeVisible();
  // The filters stay, so a filter that led here can be taken away.
  await expect(page.getByRole("group", { name: "Views" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(rows(page)).toHaveCount(8);
});

test("@journey while the log loads the frame says so, then the list draws", async ({ page }) => {
  await stub(page, () => pageOf(ROWS));
  await page.route("**/api/staff?*", json({ staff: [], total: 0 }));
  await page.route("**/api/staff-roles", json({ roles: [] }));
  await throughAccess(page, NADIA.email, "/staff");
  // Opened from the sidebar with its answer held: the frame's progress bar says it is loading
  // until the list is there. The route's own skeleton is drawn by its unit test
  // (routes/audit/-audit/audit.test.tsx).
  const held = await hold(page, "**/api/audit?*");
  await page.getByRole("link", { name: "Audit log", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Loading" })).toBeVisible();
  held.release();
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await expect(rows(page)).toHaveCount(8);
  await expect(page.getByRole("progressbar", { name: "Loading" })).toHaveCount(0);
});

test("@journey a link to an entry opens it: loading, failed with Try again, then the entry; one not in the log says so", async ({
  page,
}) => {
  const off = aud(40);
  let entryAnswer: "fail" | "ok" = "fail";
  await stub(page, () => pageOf(ROWS.slice(0, 3)));
  await page.route(`**/api/audit/${off}`, (route) =>
    entryAnswer === "fail"
      ? problem(503, "unavailable")(route)
      : json({
          entry: entry(40, "staff.factors_reset", NADIA, "2026-11-02T08:00:00.000Z", {
            target: { id: OWEN.id, label: OWEN.email },
            metadata: { sessionsEnded: 1, factorsRemoved: 2 },
          }),
        })(route),
  );
  await page.route(`**/api/audit/${aud(41)}`, problem(404, "not_found"));

  // drawerLoading, then drawerFailed.
  const held = await hold(page, `**/api/audit/${off}`);
  await throughAccess(page, NADIA.email, `/audit?view=${off}`);
  await expect(drawer(page).getByRole("group", { name: "Loading staff action" })).toBeVisible();
  held.release();
  await expect(drawer(page).getByText("Couldn’t load this staff action")).toBeVisible();
  await expect(drawer(page).getByText("Check your connection and try again.")).toBeVisible();

  // Try again: the entry, without the page's stepper (it is not on this page).
  entryAnswer = "ok";
  await drawer(page).getByRole("button", { name: "Try again" }).click();
  await expect(
    drawer(page).getByRole("heading", { name: "Reset a member of staff’s second factors" }),
  ).toBeVisible();
  await expect(drawer(page).getByText("2 → None", { exact: false })).toBeVisible();
  await expect(drawer(page).getByRole("button", { name: "Next staff action" })).toHaveCount(0);

  // An ID the log does not hold.
  await page.goto(`/audit?view=${aud(41)}`);
  await expect(drawer(page).getByText("This staff action isn’t in the audit log")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${ORIGIN}/audit`);
});

test("@journey older and newer pages follow the cursors", async ({ page }) => {
  const requests = listRequests(page);
  await stub(page, (query) => {
    if (query.get("cursor") === aud(5)) {
      return pageOf(ROWS.slice(4), { total: 8, previousCursor: aud(4) });
    }
    return pageOf(ROWS.slice(0, 4), { total: 8, nextCursor: aud(5) });
  });
  await throughAccess(page, NADIA.email, "/audit");
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Newer staff actions" })).toBeDisabled();
  await page.getByRole("button", { name: "Older staff actions" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/audit?cursor=${aud(5)}`);
  await expect(rows(page).first()).toContainText("Rejected a customer");
  expect(requests.at(-1)?.get("cursor")).toBe(aud(5));
  await expect(page.getByRole("button", { name: "Older staff actions" })).toBeDisabled();
  await page.getByRole("button", { name: "Newer staff actions" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/audit?before=${aud(4)}`);
  expect(requests.at(-1)?.get("before")).toBe(aud(4));
});

test("@journey a role without audit.read has no Audit log and cannot open it", async ({ page }) => {
  const requests = listRequests(page);
  await stub(page, () => pageOf(ROWS), ["staff.read"]);
  await page.route("**/api/staff?*", json({ staff: [], total: 0 }));
  await page.route("**/api/staff-roles", json({ roles: [] }));
  await throughAccess(page, NADIA.email, "/audit");
  await expect(inApp(page).getByText("You can’t open this page")).toBeVisible();
  await expect(page.getByRole("link", { name: "Audit log", exact: true })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  expect(requests).toHaveLength(0);
});

test.describe("against the admin API stand-in", () => {
  test.beforeEach(async () => {
    await server.reset();
  });

  test("@journey the first Admin lands on the log after enrolling, and it shows the enrolment", async ({
    page,
    authenticator: _authenticator,
    emailSink,
    addresses,
  }) => {
    const nadia = addresses.address("nadia.brooks");
    const { enrolmentCode } = await server.bootstrap(nadia);
    await throughAccess(page, nadia, "/sign-in");
    await emailedCodeSignIn(page, emailSink, nadia);
    await enrol(page, enrolmentCode, "passkey");
    await page.getByRole("link", { name: "Audit log", exact: true }).click();
    await expect(page).toHaveURL(`${ORIGIN}/audit`);
    await expect(rows(page).filter({ hasText: "Made the first Admin" })).toHaveCount(1);
    await expect(rows(page).filter({ hasText: "Added their first second factor" })).toHaveCount(1);
    const first = rows(page).filter({ hasText: "Made the first Admin" });
    await expect(first).toContainText("Operator");
    await first.click();
    await expect(drawer(page).getByText("staff.bootstrapped")).toBeVisible();
    await expect(drawer(page).getByText(nadia).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // My actions: the Admin's own rows, not the operator's.
    await page.getByRole("button", { name: "My actions" }).click();
    await expect(rows(page).filter({ hasText: "Made the first Admin" })).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "Added their first second factor" })).toHaveCount(1);
  });
});
