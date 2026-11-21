// The console's Saturday boards in a real browser (spec 02 §15.2, §19.3; spec 06 §8.2): the built
// app on the harness's static host under the production page policy (the fixtures fail a test on
// any violation or off-site request), with `/api/*` answered by the scripted stand-in in
// support/api-double.ts so each must-have state can be drawn: loading, failed, empty, no
// permission, the step-up and the refusals. What the client sends is asserted too: X-Fin-App on
// every unsafe call, the intent on the one re-send, the same Idempotency-Key.
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import {
  ApiDouble,
  BUILT_IN_ROLES,
  DEVELOPER_ROLE,
  developerViewer,
  FACTOR_STEP,
  libraryError,
  ok,
  problem,
  stepUpRequired,
  viewer,
} from "../support/api-double.ts";

const OPTIONS = {
  challenge: "Y2hhbGxlbmdlLWZvci1lMmU",
  rpId: "console.localhost",
  allowCredentials: [],
  userVerification: "required",
  timeout: 60000,
};

const MEMBERS = {
  members: [
    {
      memberId: "mem_maya",
      userId: "usr_maya",
      name: "Maya Rivera",
      email: "maya@example.com",
      roleKey: "super_admin",
      roleLabel: "Super admin",
      roleKnown: true,
      secondFactor: "passkey",
      joinedAt: "2026-11-02T10:00:00Z",
      isYou: true,
    },
    {
      memberId: "mem_priya",
      userId: "usr_priya",
      name: "Priya Shah",
      email: "priya@example.com",
      roleKey: "rol_dev",
      roleLabel: "Developer",
      roleKnown: true,
      secondFactor: "none",
      joinedAt: "2026-11-04T10:00:00Z",
      isYou: false,
    },
  ],
  membersTotal: 2,
  invitations: [
    {
      invitationId: "inv_ana",
      email: "ana@example.com",
      roleKey: "admin",
      roleLabel: "Admin",
      status: "pending",
      expiresAt: "2026-11-24T10:00:00Z",
    },
  ],
};

const AUDIT_ROW = {
  id: "aud_1",
  event: "member.role_changed",
  category: "team",
  at: "2026-11-20T14:05:00Z",
  actor: { kind: "user", id: "usr_maya", name: "Maya Rivera", email: "maya@example.com" },
  target: { id: "mem_priya", label: "Priya Shah" },
  refs: [],
  metadata: { fromRole: "rol_dev", toRole: "admin" },
  verification: "passkey",
  ipAddress: "198.51.100.24",
  device: "Chrome on Mac",
};

/** The double every signed-in board starts from: the viewer and the lists the frame reads. */
function signedIn(who: Record<string, unknown> = viewer()): ApiDouble {
  return new ApiDouble()
    .on("GET /api/viewer", ok(who))
    .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS));
}

async function enterCode(page: Page, label: string, code: string): Promise<void> {
  const input = page.getByRole("textbox", { name: label });
  await input.focus();
  await input.fill(code);
}

test.describe("signing in", () => {
  test("@journey @security sign-in: the passkey first, then the emailed code and the page asked for", async ({
    page,
  }) => {
    let signedInNow = false;
    const api = new ApiDouble()
      .on("GET /api/viewer", () => (signedInNow ? ok(viewer()) : problem(401, "unauthenticated")))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/auth/email-otp/send-verification-otp", ok({ success: true }))
      .on("POST /api/auth/sign-in/email-otp", (_request, nth) => {
        if (nth === 0) return libraryError(400, "INVALID_OTP");
        signedInNow = true;
        return ok({ token: "x" });
      })
      .on(
        "GET /api/org",
        ok({
          orgId: "org_acme",
          name: "Acme Remit",
          createdAt: "2026-11-02T10:00:00Z",
          liveStatus: "sandbox",
          roleKey: "super_admin",
          roleLabel: "Super admin",
        }),
      )
      .on("GET /api/orgs", ok({ items: [], total: 0 }));
    await api.install(page);

    await gotoReady(page, "/sign-in?next=%2Fsettings%2Forganisation");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    const email = page.getByRole("textbox", { name: "Work email" });
    await expect(email).toHaveAttribute("autocomplete", "username webauthn");

    await email.fill("maya@acme");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("That email address doesn’t look right.")).toBeVisible();

    await email.fill("maya@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/sign-in\/code\?next=%2Fsettings%2Forganisation$/);
    await expect(page.getByText("We sent a sign-in link to")).toContainText("maya@example.com");
    const sent = api.calls("POST /api/auth/email-otp/send-verification-otp");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ email: "maya@example.com", type: "sign-in" });
    expect(sent[0]?.headers["x-fin-app"]).toBe("console");

    await enterCode(page, "Or enter the 8-digit code from the email", "11111111");
    await expect(page.getByText("That code didn’t work.")).toBeVisible();
    await enterCode(page, "Or enter the 8-digit code from the email", "12345678");
    await expect(page).toHaveURL(/\/settings\/organisation$/);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    expect(api.calls("POST /api/auth/sign-in/email-otp").map((c) => c.body)).toEqual([
      { email: "maya@example.com", otp: "11111111" },
      { email: "maya@example.com", otp: "12345678" },
    ]);
  });

  test("@journey too many emails, and offline, are said on the card", async ({ page }) => {
    const api = new ApiDouble()
      .on("GET /api/viewer", problem(401, "unauthenticated"))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/auth/email-otp/send-verification-otp", (_r, nth) =>
        nth === 0 ? problem(429, "rate_limited", { retry_after: 60 }) : { fail: true },
      );
    await api.install(page);
    await gotoReady(page, "/sign-in?error=too_many_tries");
    await expect(page.getByText("You were signed out after too many wrong tries.")).toBeVisible();
    await page.getByRole("textbox", { name: "Work email" }).fill("maya@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("Too many emails were sent to this address. Try again later."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("Something went wrong on our side.").or(page.getByText("You’re offline.")),
    ).toBeVisible();
  });

  test("@journey the factor step: a wrong authenticator code, then the right one", async ({
    page,
  }) => {
    let raised = false;
    const api = new ApiDouble()
      .on("GET /api/viewer", () => ok(raised ? viewer() : FACTOR_STEP))
      .on("POST /api/auth/two-factor/verify-totp", (_r, nth) => {
        if (nth === 0) return libraryError(401, "INVALID_CODE");
        raised = true;
        return ok({ token: "x" });
      });
    await api.install(page);
    await gotoReady(page, "/");
    await expect(page).toHaveURL(/\/sign-in\/two-factor$/);
    await expect(page.getByRole("heading", { level: 1, name: "Confirm it’s you" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Enter a backup code" })).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "Trust this browser for 30 days" }),
    ).toHaveCount(0);
    await enterCode(page, "Authenticator code", "000000");
    await expect(page.getByText("That code isn’t right.", { exact: true })).toBeVisible();
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/auth/two-factor/verify-totp")[1]?.body).toEqual({ code: "123456" });
  });

  test("@journey a backup code at the factor step, and a person with none", async ({ page }) => {
    const api = new ApiDouble().on("GET /api/viewer", ok({ ...FACTOR_STEP, methods: ["passkey"] }));
    await api.install(page);
    await gotoReady(page, "/sign-in/backup-code");
    await expect(page.getByText("This account has no backup codes.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Backup code" })).toBeDisabled();
  });
});

test.describe("passkeys in the browser", () => {
  const REGISTRATION = {
    challenge: "cmVnaXN0ZXItY2hhbGxlbmdlLWUyZQ",
    rp: { name: "Fin", id: "console.localhost" },
    user: { id: "dXNyX21heWE", name: "maya@example.com", displayName: "Maya Rivera" },
    pubKeyCredParams: [
      { alg: -7, type: "public-key" },
      { alg: -257, type: "public-key" },
    ],
    timeout: 60000,
    attestation: "none",
    excludeCredentials: [],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  };

  test("@journey @security a passkey added on Protect your account, then a sign-in with it", async ({
    page,
    authenticator,
  }) => {
    let state: "held" | "protected" | "signedOut" | "signedIn" = "held";
    const held = viewer({
      gate: "protect_account",
      assurance: "aal1",
      factors: { passkeys: 0, authenticator: false, backupCodesLeft: null },
    });
    const api = new ApiDouble()
      .on("GET /api/viewer", () => {
        if (state === "held") return ok(held);
        if (state === "signedOut") return problem(401, "unauthenticated");
        return ok(
          viewer({ factors: { passkeys: 1, authenticator: false, backupCodesLeft: null } }),
        );
      })
      .on("GET /api/auth/passkey/generate-register-options", ok(REGISTRATION))
      .on("POST /api/auth/passkey/verify-registration", () => {
        state = "protected";
        return ok({ id: "pky_1" });
      })
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/auth/passkey/verify-authentication", () => {
        state = "signedIn";
        return ok({ session: {} });
      });
    await api.install(page);

    await gotoReady(page, "/welcome/secure");
    await page.getByRole("button", { name: /Add a passkey/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    const registered = api.calls("POST /api/auth/passkey/verify-registration");
    expect(registered).toHaveLength(1);
    const response = (registered[0]?.body as { response?: Record<string, unknown> } | undefined)
      ?.response;
    expect(response?.type).toBe("public-key");
    expect(typeof response?.id).toBe("string");
    expect(registered[0]?.headers["x-fin-app"]).toBe("console");
    expect(await authenticator.list(authenticator.rpIdFor(page.url()))).toHaveLength(1);

    // Signed out, the sign-in page's autofill request (conditional UI) finds the saved passkey,
    // and choosing it signs in at once (spec 02 §5.3): the virtual authenticator chooses it.
    state = "signedOut";
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    const verified = api.calls("POST /api/auth/passkey/verify-authentication");
    expect(verified).toHaveLength(1);
    const assertion = (
      verified[0]?.body as { response?: { response?: Record<string, unknown> } } | undefined
    )?.response;
    expect(typeof assertion?.response?.signature).toBe("string");
  });

  test("@journey a cancelled or failed passkey says so on the card", async ({ page }) => {
    const api = new ApiDouble()
      .on("GET /api/viewer", problem(401, "unauthenticated"))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/auth/passkey/verify-authentication", libraryError(401, "PASSKEY_NOT_FOUND"));
    await api.install(page);
    await gotoReady(page, "/sign-in");
    // No authenticator holds a passkey for this site: the browser's prompt ends with none used.
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(
      page.getByText("No passkey was used.").or(page.getByText("That passkey didn’t work.")),
    ).toBeVisible({ timeout: 70_000 });
  });
});

test.describe("protecting the account", () => {
  test("@journey a privileged person is held with no Skip; another may skip", async ({ page }) => {
    const held = viewer({
      gate: "protect_account",
      assurance: "aal1",
      factors: { passkeys: 0, authenticator: false, backupCodesLeft: null },
      canSkipProtect: false,
    });
    const api = new ApiDouble().on("GET /api/viewer", ok(held));
    await api.install(page);
    await gotoReady(page, "/settings/team");
    await expect(page).toHaveURL(/\/welcome\/secure$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Protect your account" }),
    ).toBeVisible();
    await expect(page.getByText("Your role needs a second factor.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Add a passkey/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Use an authenticator app/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Skip for now" })).toHaveCount(0);

    api.on("GET /api/viewer", ok({ ...held, gate: "ok", canSkipProtect: true }));
    await gotoReady(page, "/welcome/secure");
    await expect(page.getByRole("link", { name: "Skip for now" })).toBeVisible();
    await expect(page.getByText("Your role needs a second factor.")).toHaveCount(0);
  });

  test("@journey the authenticator set-up shows the key, takes the code, then the codes once", async ({
    page,
  }) => {
    const none = viewer({
      gate: "protect_account",
      factors: { passkeys: 0, authenticator: false, backupCodesLeft: null },
    });
    const codes = Array.from({ length: 10 }, (_, i) => `code-${String(i).padStart(4, "0")}`);
    const api = new ApiDouble()
      .on("GET /api/viewer", ok(none))
      .on(
        "POST /api/auth/two-factor/enable",
        ok({
          totpURI: "otpauth://totp/Fin:maya?secret=JBSWY3DPEHPK3PXP&issuer=Fin",
          backupCodes: codes,
        }),
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/welcome/authenticator");
    await expect(page.getByTestId("authenticator-key")).toHaveText("JBSW Y3DP EHPK 3PXP");
    expect(api.calls("POST /api/auth/two-factor/enable")[0]?.body).toEqual({});
    await enterCode(page, "2. Enter the 6-digit code it shows", "123456");
    await expect(
      page.getByRole("heading", { level: 1, name: "Save your backup codes" }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Backup codes" }).getByRole("listitem"),
    ).toHaveCount(10);
    const done = page.getByRole("button", { name: "Done" });
    await expect(done).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("checkbox", { name: "I saved these codes somewhere safe" }).click();
    await expect(done).not.toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("the team", () => {
  test("@journey @security an invitation asks for the factor and is sent again once with the intent", async ({
    page,
  }) => {
    const api = signedIn()
      .on("GET /api/team", ok(MEMBERS))
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on("POST /api/team/invitations", (_r, nth) =>
        nth === 0 ? stepUpRequired("member.invite", { intentId: "sti_invite" }) : ok({}),
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/settings/team");
    await expect(page.getByRole("row", { name: /^Priya Shah,/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /See changes in the audit log/ })).toHaveAttribute(
      "href",
      "/audit-log?type=team",
    );

    await page.getByRole("button", { name: "Invite teammate" }).click();
    const invite = page.getByRole("dialog", { name: "Invite a teammate" });
    await invite.getByRole("textbox", { name: "Work email" }).fill("kai@example.com");
    await invite.getByRole("radio", { name: /Developer/ }).check();
    await invite.getByRole("button", { name: "Send invite" }).click();

    const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
    await expect(stepUp).toContainText("Use your second factor to invite kai@example.com.");
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByText("Invitation sent to kai@example.com")).toBeVisible();

    const sends = api.calls("POST /api/team/invitations");
    expect(sends).toHaveLength(2);
    expect(sends.map((s) => s.body)).toEqual([
      { email: "kai@example.com", roleKey: "rol_dev" },
      { email: "kai@example.com", roleKey: "rol_dev" },
    ]);
    expect(sends[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sends[1]?.headers["idempotency-key"]).toBe(sends[0]?.headers["idempotency-key"]);
    expect(sends[0]?.headers["fin-step-up-intent"]).toBeUndefined();
    expect(sends[1]?.headers["fin-step-up-intent"]).toBe("sti_invite");
    expect(sends.every((s) => s.headers["x-fin-app"] === "console")).toBe(true);
    expect(sends.every((s) => s.headers["fin-organization"] === "org_acme")).toBe(true);
    const proof = api.calls("POST /api/auth/two-factor/verify-totp");
    expect(proof[0]?.headers["fin-step-up-intent"]).toBe("sti_invite");
  });

  test("@journey a Developer sees the team but cannot change it", async ({ page }) => {
    const api = signedIn(developerViewer())
      .on("GET /api/team", ok(MEMBERS))
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }));
    await api.install(page);
    await gotoReady(page, "/settings/team");
    await expect(page.getByRole("row", { name: /^Maya Rivera,/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Invite teammate" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /See changes in the audit log/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);

    await gotoReady(page, "/audit-log");
    await expect(page.getByRole("heading", { name: "You can’t open this page" })).toBeVisible();
    expect(api.calls("GET /api/audit-log")).toHaveLength(0);
  });

  test("@journey the team's failure keeps the header, and Try again loads it", async ({ page }) => {
    const api = signedIn()
      .on("GET /api/team", (_r, nth) => (nth === 0 ? problem(500, "internal") : ok(MEMBERS)))
      .on("GET /api/roles", ok({ roles: BUILT_IN_ROLES }));
    await api.install(page);
    await gotoReady(page, "/settings/team");
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Couldn’t load the team" })).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("row", { name: /^Priya Shah,/ })).toBeVisible();
  });
});

test.describe("roles", () => {
  test("@journey a new role ticks what it needs and is created with its intent", async ({
    page,
  }) => {
    const api = signedIn()
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on("POST /api/roles", (_r, nth) =>
        nth === 0
          ? stepUpRequired("role.create", { intentId: "sti_role" })
          : ok({ roleId: "rol_support" }),
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}))
      .on(
        "GET /api/roles/:roleKey",
        ok({
          roleKey: "rol_support",
          roleId: "rol_support",
          label: "Support",
          description: "",
          builtIn: false,
          permissions: ["customers.read", "money.read", "money.transfer"],
          version: 1,
          holders: 0,
        }),
      );
    await api.install(page);
    await gotoReady(page, "/settings/roles/new");
    await expect(page.getByRole("heading", { level: 1, name: "New role" })).toBeVisible();
    await expect(
      page.locator("p", { hasText: "Name the role and tick at least one permission." }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Name" }).fill("Support");
    await page.getByRole("checkbox", { name: /^Send money/ }).click();
    await expect(page.getByRole("checkbox", { name: /^See customers/ })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /^See money movement/ })).toBeChecked();
    await expect(page.getByText("Support can do 3 things.")).toBeVisible();

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText(
      "Use your second factor to create the role Support.",
    );
    await enterCode(page, "Authenticator code", "123456");
    await expect(page).toHaveURL(/\/settings\/roles\/rol_support$/);
    await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
    const creates = api.calls("POST /api/roles");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.body).toEqual({
      name: "Support",
      description: "",
      permissions: ["customers.read", "money.read", "money.transfer"],
    });
    expect(creates[1]?.headers["fin-step-up-intent"]).toBe("sti_role");
  });

  test("@journey a built-in role is read-only and the list links each role", async ({ page }) => {
    const api = signedIn()
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on(
        "GET /api/roles/:roleKey",
        ok({
          roleKey: "admin",
          roleId: null,
          label: "Admin",
          builtIn: true,
          permissions: BUILT_IN_ROLES[1]?.permissions ?? [],
          version: null,
          holders: 1,
        }),
      );
    await api.install(page);
    await gotoReady(page, "/settings/roles");
    await expect(page.getByRole("link", { name: /See changes in the audit log/ })).toHaveAttribute(
      "href",
      "/audit-log?type=team&targetKind=role",
    );
    await page.getByRole("link", { name: "Admin", exact: true }).click();
    await expect(page.getByText("Built-in roles can’t be changed.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^See customers/ })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Duplicate" })).toHaveAttribute(
      "href",
      "/settings/roles/new?from=admin",
    );
  });
});

test.describe("the audit log", () => {
  test("@journey filtered to one member from the Team row menu, with its entry", async ({
    page,
  }) => {
    const api = signedIn()
      .on("GET /api/team", ok(MEMBERS))
      .on("GET /api/roles", ok({ roles: BUILT_IN_ROLES }))
      .on("GET /api/audit-log", (request) =>
        ok({
          items: [AUDIT_ROW],
          total: 1,
          filterLabel: request.search.get("target") === "mem_priya" ? "Priya Shah" : null,
        }),
      );
    await api.install(page);
    await gotoReady(page, "/settings/team");
    await page.getByRole("button", { name: "Actions for Priya Shah" }).click();
    await page.getByRole("menuitem", { name: "View in audit log" }).click();
    await expect(page).toHaveURL(/\/audit-log\?target=mem_priya$/);
    await expect(page.getByRole("button", { name: "Remove filter: Priya Shah" })).toBeVisible();
    const table = page.getByRole("table", { name: "Audit log" });
    await expect(table).toContainText("Maya Rivera changed the role of Priya Shah to Admin");
    await expect(table).toContainText("198.51.100.24 · Chrome on Mac");
    expect(api.calls("GET /api/audit-log").at(-1)?.search.get("target")).toBe("mem_priya");

    await table.getByText("Maya Rivera changed the role").click();
    const entry = page.getByRole("dialog", { name: /Changed the role of Priya Shah to Admin/ });
    await expect(entry).toContainText("Passkey");
    await expect(page).toHaveURL(/view=aud_1/);
    await page.goBack();
    await expect(entry).toHaveCount(0);
  });

  test("@journey the empty states and a failed load", async ({ page }) => {
    const api = signedIn().on("GET /api/audit-log", (request, nth) => {
      if (nth === 0) return problem(500, "internal");
      return ok({ items: [], total: 0, filterLabel: null, range: request.search.get("range") });
    });
    await api.install(page);
    await gotoReady(page, "/audit-log");
    await expect(page.getByText("Couldn’t load the audit log")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("heading", { name: "No events in the last 30 days" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show all time" }).click();
    await expect(page.getByRole("heading", { name: "No events yet" })).toBeVisible();
    await page.getByRole("button", { name: "Team" }).click();
    await expect(page.getByRole("heading", { name: "No events match" })).toBeVisible();
  });
});

test.describe("account security", () => {
  test("@journey the methods and sessions, and signing out everywhere else with the factor", async ({
    page,
  }) => {
    const api = signedIn()
      .on("GET /api/account/security", {
        delayMs: 400,
        status: 200,
        body: {
          name: "Maya Rivera",
          email: "maya@example.com",
          passkeys: [{ id: "pky_1", name: "Chrome on Mac", createdAt: "2026-11-02T10:05:00Z" }],
          authenticator: true,
          backupCodesLeft: 8,
          trustedBrowsers: [],
          noSecondFactor: false,
        },
      })
      .on(
        "GET /api/account/sessions",
        ok({
          items: [
            {
              id: "ses_1",
              device: "Chrome on Mac",
              ipAddress: "198.51.100.24",
              createdAt: "2026-11-20T09:14:00Z",
              lastSeenAt: "2026-11-20T09:14:00Z",
              current: true,
            },
            {
              id: "ses_2",
              device: "Safari on iPhone",
              ipAddress: "198.51.100.61",
              createdAt: "2026-11-18T09:14:00Z",
              lastSeenAt: "2026-11-18T09:14:00Z",
              current: false,
            },
          ],
          total: 2,
        }),
      )
      .on("GET /api/account/activity", ok({ items: [], total: 0 }))
      .on("POST /api/account/sessions/revoke-others", (_r, nth) =>
        nth === 0
          ? stepUpRequired("account.sessions_revoke_others", { intentId: "sti_others" })
          : ok({ revoked: 1 }),
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/account/security");
    await expect(
      page
        .getByText("Loading your sign-in methods")
        .or(page.getByRole("table", { name: "Your sign-in methods" })),
    ).toBeAttached();
    const methods = page.getByRole("table", { name: "Your sign-in methods" });
    await expect(methods).toContainText("Passkey · Chrome on Mac");
    await expect(methods).toContainText("8 of 10 left");
    await expect(page.getByRole("table", { name: "Where you’re signed in" })).toContainText(
      "This device",
    );

    await page.getByRole("button", { name: "Sign out everywhere else" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText(
      "Use your second factor to sign out your other devices.",
    );
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByText("Signed out everywhere else")).toBeVisible();
    expect(
      api.calls("POST /api/account/sessions/revoke-others")[1]?.headers["fin-step-up-intent"],
    ).toBe("sti_others");
  });

  test("@journey a failed load says so, and Try again loads it", async ({ page }) => {
    const api = signedIn()
      .on("GET /api/account/security", (_r, nth) =>
        nth === 0
          ? problem(500, "internal")
          : ok({
              name: "",
              email: "maya@example.com",
              passkeys: [],
              authenticator: false,
              backupCodesLeft: null,
              noSecondFactor: true,
            }),
      )
      .on("GET /api/account/sessions", ok({ items: [], total: 0 }))
      .on("GET /api/account/activity", ok({ items: [], total: 0 }));
    await api.install(page);
    await gotoReady(page, "/account/security");
    await expect(
      page.getByRole("heading", { name: "Couldn’t load your sign-in methods" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("You have no second factor yet.")).toBeVisible();
    await expect(
      page.getByText(
        "Your account has no name yet. It is shown to your team and in the audit log.",
      ),
    ).toBeVisible();
  });
});

test.describe("on a phone and in the dark", () => {
  test("@phone @visual the signed-out card and Settings fit, with no sideways scroll", async ({
    page,
  }) => {
    const api = signedIn()
      .on(
        "GET /api/org",
        ok({
          orgId: "org_acme",
          name: "Acme Remit",
          createdAt: "2026-11-02T10:00:00Z",
          liveStatus: "sandbox",
          roleKey: "super_admin",
          roleLabel: "Super admin",
        }),
      )
      .on(
        "GET /api/orgs",
        ok({
          items: [
            {
              orgId: "org_acme",
              name: "Acme Remit",
              roleKey: "super_admin",
              roleLabel: "Super admin",
              liveStatus: "sandbox",
            },
          ],
          total: 1,
        }),
      );
    await api.install(page);
    await gotoReady(page, "/settings/organisation");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Organisation name" })).toHaveValue(
      "Acme Remit",
    );
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await fits()).toBe(true);

    api.on("GET /api/viewer", problem(401, "unauthenticated"));
    await gotoReady(page, "/sign-in");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin" })).toBeVisible();
    expect(await fits()).toBe(true);
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(["light", "dark"]).toContain(theme);
  });
});
