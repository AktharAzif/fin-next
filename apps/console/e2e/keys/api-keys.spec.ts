// The API keys page in a real browser (ApiKeys, ApiKeyCreate and ApiKeyActions boards; spec 02 §12.3,
// §12.4; spec 05 §4.6): the built app on the harness's static host under the production page policy,
// with `/api/*` answered by the scripted stand-in (support/api-double.ts), so each must-have state can
// be drawn. The journeys: create a key through the StepUp dialog and see its secret once (Done waits
// for the tick; closing asks first; nothing shows it again), roll it with an overlap and see the new
// secret, revoke it, a role that may only read (every change disabled with the reason), a role
// without the permission (the page refused), the empty, loading and failed states, a paused
// organisation's Production keys still listed and revocable, and a list past one page. What the
// client sends is asserted: the intent on the one re-send, X-Fin-App, the organisation, the body.
// The step-up and the route's own refusals are proved on the server (keys.db.test.ts).
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import {
  ApiDouble,
  developerViewer,
  ORG,
  ok,
  problem,
  type Recorded,
  stepUpRequired,
  viewer,
} from "../support/api-double.ts";

// Built at run time: the repository holds no key with a valid checksum (T05-03).
const SECRET = ["fin", "test", "rk", `K8D2M4P6Q1${"a1B2".repeat(9)}Zz`].join("_");
const ROLLED = ["fin", "test", "rk", `W6N4R3T5V7${"c3D4".repeat(9)}Yy`].join("_");

const ALL_SCOPES = [
  "customers:read",
  "customers:write",
  "events:read",
  "money:read",
  "money:write",
  "beneficiaries:write",
  "sandbox:simulate",
  "sandbox:deposit",
];

function keyRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    keyId: "K8D2M4P6Q1",
    name: "Payout worker",
    prefix: "fin_test_rk_K8D2M4P6Q1",
    mode: "test",
    kind: "rk",
    access: "Restricted · 2 scopes",
    scopes: ["customers:read", "money:read"],
    ipAllowlist: [],
    status: "active",
    createdAt: "2026-11-20T10:00:00.000Z",
    createdBy: { userId: "usr_maya", name: "Maya Rivera" },
    expiresAt: "2027-02-18T10:00:00.000Z",
    revokedAt: null,
    revokedReason: null,
    rollingUntil: null,
    replacedBy: null,
    lastUsedAt: null,
    flags: { makerLacksPermissions: false, secretUnseen: false },
    ...over,
  };
}

const CAN_ALL = {
  test: { manage: true, fullAccess: true, scopes: ALL_SCOPES },
  live: { manage: true, fullAccess: true, scopes: ALL_SCOPES.slice(0, 6), approved: false },
};

function list(keys: Record<string, unknown>[], can = CAN_ALL) {
  return ok({ keys, total: keys.length, page: 1, size: 100, working: keys.length, limit: 50, can });
}

/** The page reads both modes: these journeys' keys are Sandbox keys, so the live list is empty. */
const sandboxKeys = (request: Recorded, keys: Record<string, unknown>[]) =>
  request.search.get("mode") === "live" ? [] : keys;

const dialog = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });
/** A confirmation: the design system draws it as an alert dialog. */
const confirmation = (page: Page, name: string) => page.getByRole("alertdialog", { name });

async function proveWithCode(page: Page): Promise<void> {
  const step = dialog(page, "Confirm it’s you");
  await expect(step).toBeVisible();
  const input = step.getByRole("textbox", { name: "Authenticator code" });
  await input.focus();
  await input.fill("123456");
}

function lastCall(api: ApiDouble, key: string): Recorded {
  const calls = api.calls(key);
  const last = calls.at(-1);
  if (last === undefined) throw new Error(`no call to ${key}`);
  return last;
}

test.describe("the API keys page", () => {
  test("@journey create a key through the StepUp dialog, and see its secret once", async ({
    page,
  }) => {
    let keys: Record<string, unknown>[] = [];
    const api = new ApiDouble()
      .on("GET /api/viewer", ok(viewer()))
      .on("GET /api/keys", (r) => list(sandboxKeys(r, keys)))
      .on("POST /api/keys", (_r, nth) => {
        if (nth === 0) return stepUpRequired("key.create", { intentId: "sti_create" });
        keys = [
          keyRow({
            name: "Ledger sync",
            access: "Restricted · 1 scope",
            scopes: ["customers:read"],
          }),
        ];
        return { status: 201, body: { secret: SECRET, key: keys[0] } };
      })
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/developers/keys");
    await expect(page.getByRole("heading", { name: "API keys", level: 1 })).toBeVisible();
    // The first-use state: the empty state's button is the one primary.
    await expect(page.getByText("No keys yet")).toBeVisible();
    await expect(page.getByText("Production keys unlock when Fin approves you")).toBeVisible();

    await page.getByRole("button", { name: "Create key" }).first().click();
    const form = dialog(page, "Create a key");
    await form.getByRole("textbox", { name: "Name" }).fill("ledger.sync");
    await form.getByRole("button", { name: "Create key" }).click();
    await expect(form.getByText(/can’t look like a web or email address/)).toBeVisible();
    expect(api.calls("POST /api/keys")).toHaveLength(0);
    await form.getByRole("textbox", { name: "Name" }).fill("Ledger sync");
    await form.getByRole("checkbox", { name: "money:read" }).click();
    await form.getByRole("button", { name: "Create key" }).click();
    await proveWithCode(page);

    const secretView = dialog(page, "Ledger sync");
    await expect(secretView.getByText("Copy your secret now")).toBeVisible();
    await expect(secretView.getByText(SECRET)).toBeVisible();
    const sends = api.calls("POST /api/keys");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.headers["fin-step-up-intent"]).toBe("sti_create");
    expect(sends[1]?.headers["x-fin-app"]).toBe("console");
    expect(sends[1]?.headers["fin-organization"]).toBe("org_acme");
    expect(sends[1]?.body).toEqual(sends[0]?.body);
    expect(sends[1]?.body).toEqual({
      name: "Ledger sync",
      mode: "test",
      kind: "rk",
      scopes: ["customers:read"],
      ipAllowlist: [],
      expiresIn: "90d",
    });

    // Done waits for the tick; Escape asks before closing without it.
    await expect(secretView.getByRole("button", { name: "Done" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(confirmation(page, "Close without copying?")).toBeVisible();
    await confirmation(page, "Close without copying?")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(confirmation(page, "Close without copying?")).toHaveCount(0);
    const tick = secretView.getByRole("checkbox", {
      name: "I have stored this key somewhere safe",
    });
    await tick.click();
    await expect(tick).toBeChecked();
    await secretView.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Key created")).toBeVisible();
    // Once closed, the secret is nowhere on the page.
    await expect(page.getByRole("table", { name: "Sandbox keys" })).toContainText("Ledger sync");
    await expect(page.getByText(SECRET)).toHaveCount(0);
  });

  test("@journey roll a key with an overlap and see the new secret once, then revoke it", async ({
    page,
  }) => {
    let keys = [keyRow()];
    const api = new ApiDouble()
      .on("GET /api/viewer", ok(viewer()))
      .on("GET /api/keys", (r) => list(sandboxKeys(r, keys)))
      .on("POST /api/keys/:keyId/roll", (_r, nth) => {
        if (nth === 0) return stepUpRequired("key.roll", { intentId: "sti_roll" });
        const fresh = keyRow({ keyId: "W6N4R3T5V7", prefix: "fin_test_rk_W6N4R3T5V7" });
        const replaced = keyRow({
          status: "rolling",
          rollingUntil: "2026-11-23T10:00:00.000Z",
          replacedBy: "W6N4R3T5V7",
        });
        keys = [fresh, replaced];
        return ok({ secret: ROLLED, key: fresh, replaced });
      })
      .on("POST /api/keys/:keyId/revoke", (_r, nth) => {
        if (nth === 0) return stepUpRequired("key.revoke", { intentId: "sti_revoke" });
        const revoked = keyRow({
          keyId: "W6N4R3T5V7",
          prefix: "fin_test_rk_W6N4R3T5V7",
          status: "revoked",
          revokedAt: "2026-11-22T10:00:00.000Z",
        });
        keys = [revoked, keys[1] as Record<string, unknown>];
        return ok({ key: revoked });
      })
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/developers/keys");
    const table = page.getByRole("table", { name: "Sandbox keys" });
    await expect(table).toContainText("Payout worker");

    await table.getByRole("button", { name: "Actions for Payout worker" }).click();
    await page.getByRole("menuitem", { name: "Roll key" }).click();
    const roll = dialog(page, "Roll Payout worker?");
    await roll.getByRole("radio", { name: "1 hour" }).check();
    await roll.getByRole("button", { name: "Roll key" }).click();
    await proveWithCode(page);
    const secretView = dialog(page, "Payout worker");
    await expect(secretView.getByText(ROLLED)).toBeVisible();
    const sent = lastCall(api, "POST /api/keys/:keyId/roll");
    expect(sent.path).toBe("/api/keys/K8D2M4P6Q1/roll");
    expect(sent.body).toEqual({ overlap: "1h" });
    expect(sent.headers["fin-step-up-intent"]).toBe("sti_roll");
    await secretView
      .getByRole("checkbox", { name: "I have stored this key somewhere safe" })
      .click();
    await secretView.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Key rolled")).toBeVisible();
    await expect(table).toContainText("Rolling, still valid");

    await table.getByRole("button", { name: "Actions for Payout worker" }).first().click();
    await page.getByRole("menuitem", { name: "Revoke key" }).click();
    const confirm = confirmation(page, "Revoke Payout worker?");
    await expect(confirm).toContainText("fin_test_rk_W6N4R3T5V7 stops working at once");
    await confirm.getByRole("button", { name: "Revoke key" }).click();
    await proveWithCode(page);
    await expect(page.getByText("Key revoked")).toBeVisible();
    expect(lastCall(api, "POST /api/keys/:keyId/revoke").headers["fin-step-up-intent"]).toBe(
      "sti_revoke",
    );
    await expect(table).toContainText("Revoked");
  });

  test("@journey a role that may only read sees the keys with every change disabled", async ({
    page,
  }) => {
    const api = new ApiDouble()
      .on("GET /api/viewer", ok(developerViewer()))
      .on("GET /api/keys", (r) =>
        list(sandboxKeys(r, [keyRow()]), {
          test: { manage: false, fullAccess: false, scopes: [] },
          live: { manage: false, fullAccess: false, scopes: [], approved: false },
        }),
      );
    await api.install(page);
    await gotoReady(page, "/developers/keys");
    await expect(page.getByRole("table", { name: "Sandbox keys" })).toContainText("Payout worker");
    await expect(page.getByRole("button", { name: "Create key" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(page.getByRole("button", { name: "Actions for Payout worker" })).toHaveCount(0);
    await page.getByRole("table", { name: "Sandbox keys" }).getByText("Payout worker").click();
    const detail = dialog(page, "Payout worker");
    await expect(detail).toContainText("Restricted · 2 scopes");
    await expect(detail.getByRole("button", { name: "Revoke key" })).toHaveCount(0);
    expect(api.calls("POST /api/keys")).toHaveLength(0);
  });

  test("@journey a role without the permission is refused the page", async ({ page }) => {
    const api = new ApiDouble().on(
      "GET /api/viewer",
      ok(viewer({ permissions: ["member.read", "auditLog.read"] })),
    );
    await api.install(page);
    await gotoReady(page, "/developers/keys");
    await expect(page.getByText("You can’t open this page")).toBeVisible();
    expect(api.calls("GET /api/keys")).toHaveLength(0);
  });

  test("@journey draws the loading state, then a failure with Try again", async ({ page }) => {
    let failed = false;
    const api = new ApiDouble().on("GET /api/viewer", ok(viewer())).on("GET /api/keys", (r) => {
      if (r.search.get("mode") === "test" && !failed) {
        failed = true;
        return { ...problem(503, "unavailable"), delayMs: 600 };
      }
      return list(sandboxKeys(r, [keyRow()]));
    });
    await api.install(page);
    await gotoReady(page, "/developers/keys");
    await expect(page.getByText("Couldn’t load API keys").first()).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(page.getByRole("table", { name: "Sandbox keys" })).toContainText("Payout worker");
  });

  test("@journey a paused organisation still lists its Production keys, and can revoke one", async ({
    page,
  }) => {
    const liveKey = keyRow({
      keyId: "L7M3N5P9Q2",
      prefix: "fin_live_rk_L7M3N5P9Q2",
      mode: "live",
      name: "Payouts live",
    });
    const api = new ApiDouble()
      .on("GET /api/viewer", ok(viewer({ memberships: [{ ...ORG, liveStatus: "paused" }] })))
      .on("GET /api/keys", (r) => list(r.search.get("mode") === "live" ? [liveKey] : [keyRow()]));
    await api.install(page);
    await gotoReady(page, "/developers/keys");
    const production = page.getByRole("table", { name: "Production keys" });
    await expect(production).toContainText("Payouts live");
    await expect(page.getByText(/Fin has paused Production/)).toBeVisible();
    await expect(page.getByText("Production keys unlock when Fin approves you")).toHaveCount(0);
    await production.getByRole("button", { name: "Actions for Payouts live" }).click();
    await expect(page.getByRole("menuitem", { name: "Revoke key" })).toBeVisible();
    expect(api.calls("GET /api/keys").map((r) => r.search.get("mode"))).toContain("live");
  });

  test("@journey pages past the first hundred keys", async ({ page }) => {
    const first = Array.from({ length: 100 }, (_, i) =>
      keyRow({
        keyId: `K${String(i).padStart(9, "0")}`,
        prefix: `fin_test_rk_K${String(i).padStart(9, "0")}`,
        name: `Key ${i}`,
      }),
    );
    const oldest = keyRow({
      keyId: "Z9Y8X7W6V5",
      prefix: "fin_test_rk_Z9Y8X7W6V5",
      name: "Oldest key",
      status: "revoked",
      revokedAt: "2026-11-01T10:00:00.000Z",
    });
    const api = new ApiDouble().on("GET /api/viewer", ok(viewer())).on("GET /api/keys", (r) => {
      if (r.search.get("mode") === "live") return list([]);
      const n = Number(r.search.get("page") ?? "1");
      return ok({
        keys: n === 1 ? first : [oldest],
        total: 101,
        page: n,
        size: 100,
        working: 50,
        limit: 50,
        can: CAN_ALL,
      });
    });
    await api.install(page);
    await gotoReady(page, "/developers/keys");
    const sandbox = page.getByRole("table", { name: "Sandbox keys" });
    await expect(sandbox).toContainText("Key 0");
    await expect(page.getByText("1–100 of 101 keys")).toBeVisible();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(sandbox).toContainText("Oldest key");
    const asked = api.calls("GET /api/keys").filter((r) => r.search.get("mode") === "test");
    expect(asked.map((r) => r.search.get("page"))).toEqual(["1", "2"]);
  });
});
