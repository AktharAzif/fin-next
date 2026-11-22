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
  noContent,
  ok,
  problem,
  type Recorded,
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

/** The 8-digit code in a sign-in or confirm link's fragment (`#e=…&c=…`). */
const LINK_CODE = "12345678";

const SECURITY_DATA = {
  name: "Maya Rivera",
  email: "maya@example.com",
  passkeys: [{ id: "pky_1", name: "Chrome on Mac", createdAt: "2026-11-02T10:05:00Z" }],
  authenticator: true,
  backupCodesLeft: 8,
  trustedBrowsers: [],
  noSecondFactor: false,
};

const SESSIONS = [
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
];

const ORG_PROFILE = {
  orgId: "org_acme",
  name: "Acme Remit",
  createdAt: "2026-11-02T10:00:00Z",
  liveStatus: "sandbox",
  roleKey: "super_admin",
  roleLabel: "Super admin",
};

const ORG_ROW = {
  orgId: "org_acme",
  name: "Acme Remit",
  roleKey: "super_admin",
  roleLabel: "Super admin",
  liveStatus: "sandbox",
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
    await expect(page.getByText("That email address doesn’t look right.").first()).toBeVisible();

    await email.fill("maya@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/sign-in\/code\?next=%2Fsettings%2Forganisation$/);
    await expect(page.getByText("We sent a sign-in link to")).toContainText("maya@example.com");
    const sent = api.calls("POST /api/auth/email-otp/send-verification-otp");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ email: "maya@example.com", type: "sign-in" });
    expect(sent[0]?.headers["x-fin-app"]).toBe("console");

    await enterCode(page, "Or enter the 8-digit code from the email", "11111111");
    await expect(page.getByText("That code didn’t work.").first()).toBeVisible();
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
    await expect(
      page.getByText("You were signed out after too many wrong tries.").first(),
    ).toBeVisible();
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
    await expect(page.getByText("That code isn’t right.", { exact: true }).first()).toBeVisible();
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/auth/two-factor/verify-totp")[1]?.body).toEqual({ code: "123456" });
  });

  test("@journey a backup code at the factor step, and a person with none", async ({ page }) => {
    const api = new ApiDouble().on("GET /api/viewer", ok({ ...FACTOR_STEP, methods: ["passkey"] }));
    await api.install(page);
    await gotoReady(page, "/sign-in/backup-code");
    await expect(page.getByText("This account has no backup codes.").first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Backup code" })).toBeDisabled();
  });

  test("@journey @security a sign-in link in the browser that asked signs in only on the press", async ({
    page,
  }) => {
    let signedInNow = false;
    const api = new ApiDouble()
      .on("GET /api/viewer", () => (signedInNow ? ok(viewer()) : problem(401, "unauthenticated")))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/sign-in/code-link", ok({ asking: true }))
      .on("POST /api/auth/sign-in/email-otp", () => {
        signedInNow = true;
        return ok({ token: "x" });
      });
    await api.install(page);
    await gotoReady(page, `/sign-in/code#e=maya%40example.com&c=${LINK_CODE}`);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin" })).toBeVisible();
    await expect(page.getByText("As maya@example.com.").first()).toBeVisible();
    // The fragment is read once and taken out of the address bar and the history.
    expect(await page.evaluate(() => window.location.hash)).toBe("");
    expect(page.url()).not.toContain(LINK_CODE);
    expect(api.calls("POST /api/sign-in/code-link").map((c) => c.body)).toEqual([
      { email: "maya@example.com" },
    ]);
    // Never a sign-in by itself, so a mail scanner that opens the link uses nothing.
    await page.waitForTimeout(500);
    expect(api.calls("POST /api/auth/sign-in/email-otp")).toHaveLength(0);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/auth/sign-in/email-otp").map((c) => c.body)).toEqual([
      { email: "maya@example.com", otp: LINK_CODE },
    ]);
  });

  test("@journey @security a sign-in link opened in another browser drops its address and code", async ({
    page,
  }) => {
    let signedInNow = false;
    const api = new ApiDouble()
      .on("GET /api/viewer", () => (signedInNow ? ok(viewer()) : problem(401, "unauthenticated")))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/sign-in/code-link", ok({ asking: false }))
      .on("POST /api/auth/sign-in/email-otp", () => {
        signedInNow = true;
        return ok({ token: "x" });
      });
    await api.install(page);
    await gotoReady(page, `/sign-in/code#e=maya%40example.com&c=${LINK_CODE}`);
    await expect(
      page.getByText("This link was opened in a different browser from the one that asked for it."),
    ).toBeVisible();
    await expect(
      page.getByText("Open it there, or enter your email and its code here."),
    ).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe("");
    // The empty form: the link's address and code are nowhere on the page (S2-39).
    const email = page.getByRole("textbox", { name: "Work email" });
    await expect(email).toHaveValue("");
    const code = page.getByRole("textbox", { name: "Or enter the 8-digit code from the email" });
    await expect(code).toHaveValue("");
    await expect(page.getByText("maya@example.com")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(api.calls("POST /api/auth/sign-in/email-otp")).toHaveLength(0);
    // What the person types is what is sent.
    await email.fill("priya@example.com");
    await enterCode(page, "Or enter the 8-digit code from the email", "87654321");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/auth/sign-in/email-otp").map((c) => c.body)).toEqual([
      { email: "priya@example.com", otp: "87654321" },
    ]);
  });

  test("@journey @security a confirm link: one press in the browser that signed up", async ({
    page,
  }) => {
    let signedInNow = false;
    const api = new ApiDouble()
      .on("GET /api/viewer", () => (signedInNow ? ok(viewer()) : problem(401, "unauthenticated")))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/sign-in/code-link", ok({ asking: true }))
      .on("POST /api/auth/sign-in/email-otp", () => {
        signedInNow = true;
        return { status: 200, body: { token: "x" }, delayMs: 500 };
      });
    await api.install(page);
    await gotoReady(page, `/verify-email#e=maya%40example.com&c=${LINK_CODE}`);
    await expect(page.getByRole("heading", { level: 1, name: "Confirm your email" })).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe("");
    await page.waitForTimeout(500);
    expect(api.calls("POST /api/auth/sign-in/email-otp")).toHaveLength(0);
    const confirm = page.getByRole("button", { name: "Confirm email" });
    await confirm.click();
    await expect(confirm).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/auth/sign-in/email-otp").map((c) => c.body)).toEqual([
      { email: "maya@example.com", otp: LINK_CODE },
    ]);
  });

  test("@journey @security a confirm link opened in another browser drops its address and code", async ({
    page,
  }) => {
    const api = new ApiDouble()
      .on("GET /api/viewer", problem(401, "unauthenticated"))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("POST /api/sign-in/code-link", ok({ asking: false }))
      .on("POST /api/auth/sign-in/email-otp", ok({ token: "x" }));
    await api.install(page);
    await gotoReady(page, `/verify-email#e=maya%40example.com&c=${LINK_CODE}`);
    await expect(
      page.getByText("Open it in the browser you signed up in, or type its code there."),
    ).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe("");
    await expect(page.getByRole("textbox", { name: "Work email" })).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "Confirmation code" })).toHaveValue("");
    await expect(page.getByText("maya@example.com")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(api.calls("POST /api/auth/sign-in/email-otp")).toHaveLength(0);
  });

  test("@journey sign-up: the form, then the emailed code in the same browser", async ({
    page,
  }) => {
    let signedInNow = false;
    const api = new ApiDouble()
      .on("GET /api/viewer", () => (signedInNow ? ok(viewer()) : problem(401, "unauthenticated")))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on("GET /api/invitation", noContent())
      .on("POST /api/sign-up", { status: 200, body: { status: "code_sent" }, delayMs: 500 })
      .on("POST /api/auth/sign-in/email-otp", () => {
        signedInNow = true;
        return { status: 200, body: { token: "x" }, delayMs: 500 };
      });
    await api.install(page);
    await gotoReady(page, "/sign-up");
    await expect(
      page.getByRole("heading", { level: 1, name: "Create your Fin account" }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Full name" }).fill("Maya Rivera");
    await page.getByRole("textbox", { name: "Work email" }).fill("maya@example.com");
    const create = page.getByRole("button", { name: "Create account" });
    await create.click();
    await expect(create).toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(/\/verify-email$/);
    await expect(page.getByText("is waiting to be confirmed")).toContainText("maya@example.com");
    expect(api.calls("POST /api/sign-up").map((c) => c.body)).toEqual([
      { name: "Maya Rivera", email: "maya@example.com" },
    ]);
    await enterCode(page, "Confirmation code", "12345678");
    await expect(page.getByRole("button", { name: "Confirm email" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/auth/sign-in/email-otp").map((c) => c.body)).toEqual([
      { email: "maya@example.com", otp: "12345678" },
    ]);
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
    await expect(page.getByText("Your role needs a second factor.").first()).toBeVisible();
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
    await expect(page.getByText("Invitation sent to kai@example.com").first()).toBeVisible();

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

  test("@journey @security the invite dialog starts with no role chosen, and Send waits for one", async ({
    page,
  }) => {
    const api = signedIn()
      .on("GET /api/team", ok(MEMBERS))
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on("POST /api/team/invitations", ok({}));
    await api.install(page);
    await gotoReady(page, "/settings/team?view=invite");
    const invite = page.getByRole("dialog", { name: "Invite a teammate" });
    // A Super admin may give every role, Super admin first; none is chosen for them.
    await expect(invite.getByRole("radio", { name: /^Super admin/ })).toBeEnabled();
    await expect(invite.getByRole("radio", { checked: true })).toHaveCount(0);
    const send = invite.getByRole("button", { name: "Send invite" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    const email = invite.getByRole("textbox", { name: "Work email" });
    await email.fill("kai@example.com");
    await email.press("Enter");
    await expect(invite.getByText("The invitation wasn’t sent")).toBeVisible();
    expect(api.calls("POST /api/team/invitations")).toHaveLength(0);
    await invite.getByRole("radio", { name: /^Developer/ }).check();
    await expect(send).not.toHaveAttribute("aria-disabled", "true");
    await send.click();
    await expect(page.getByText("Invitation sent to kai@example.com").first()).toBeVisible();
    expect(api.calls("POST /api/team/invitations").map((c) => c.body)).toEqual([
      { email: "kai@example.com", roleKey: "rol_dev" },
    ]);
  });

  test("@journey @security one invitation change at a time, and the factor names its invitation", async ({
    page,
  }) => {
    const bob = {
      invitationId: "inv_bob",
      email: "bob@example.com",
      roleKey: "rol_dev",
      roleLabel: "Developer",
      status: "pending",
      expiresAt: "2026-11-24T10:00:00Z",
    };
    const api = signedIn()
      .on("GET /api/team", ok({ ...MEMBERS, invitations: [...MEMBERS.invitations, bob] }))
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on("POST /api/team/invitations/:invitationId/resend", (_r, nth) =>
        nth === 0
          ? { ...stepUpRequired("invitation.resend", { intentId: "sti_resend" }), delayMs: 1500 }
          : ok({}),
      )
      .on("DELETE /api/team/invitations/:invitationId", ok({}))
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/settings/team");
    await page
      .getByRole("button", { name: "Actions for the invitation to ana@example.com" })
      .click();
    await page.getByRole("menuitem", { name: "Resend" }).click();
    // While Ana's resend runs, every other row's actions wait for it.
    await expect(
      page.getByRole("button", {
        name: "Actions for the invitation to bob@example.com",
        includeHidden: true,
      }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      page.getByRole("button", { name: "Actions for Priya Shah", includeHidden: true }),
    ).toHaveAttribute("aria-disabled", "true");
    const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
    await expect(stepUp).toContainText(
      "Use your second factor to send the invitation to ana@example.com again.",
    );
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByText("Invitation sent again to ana@example.com").first()).toBeVisible();
    const resends = api.calls("POST /api/team/invitations/:invitationId/resend");
    expect(resends.map((r) => r.path)).toEqual([
      "/api/team/invitations/inv_ana/resend",
      "/api/team/invitations/inv_ana/resend",
    ]);
    expect(resends[1]?.headers["fin-step-up-intent"]).toBe("sti_resend");
    expect(api.calls("DELETE /api/team/invitations/:invitationId")).toHaveLength(0);
    await expect(
      page.getByRole("button", { name: "Actions for the invitation to bob@example.com" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  test("@journey @security a member's role changes with the factor", async ({ page }) => {
    const api = signedIn()
      .on("GET /api/team", ok(MEMBERS))
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on("GET /api/team/members/:memberId/credentials", ok({ items: [] }))
      .on("PATCH /api/team/members/:memberId", (_r, nth) =>
        nth === 0 ? stepUpRequired("member.role", { intentId: "sti_role_change" }) : ok({}),
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/settings/team");
    await page.getByRole("button", { name: "Actions for Priya Shah" }).click();
    await page.getByRole("menuitem", { name: "Change role" }).click();
    const change = page.getByRole("dialog", { name: "Change Priya Shah’s role" });
    // The member's own role is where the picker starts: Save waits for a change.
    await expect(change.getByRole("radio", { name: /^Developer/ })).toBeChecked();
    await expect(change.getByRole("button", { name: "Save" })).toBeDisabled();
    await change.getByRole("radio", { name: /^Admin/ }).check();
    await change.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText(
      "Use your second factor to change Priya Shah’s role to Admin.",
    );
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByText("Priya Shah’s role is now Admin").first()).toBeVisible();
    const sends = api.calls("PATCH /api/team/members/:memberId");
    expect(sends.map((s) => s.body)).toEqual([
      { roleKey: "admin", rollCredentials: true },
      { roleKey: "admin", rollCredentials: true },
    ]);
    expect(sends[1]?.headers["fin-step-up-intent"]).toBe("sti_role_change");
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
    await expect(page.getByText("Support can do 3 things.").first()).toBeVisible();

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
    await expect(page.getByText("Built-in roles can’t be changed.").first()).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^See customers/ })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Duplicate" })).toHaveAttribute(
      "href",
      "/settings/roles/new?from=admin",
    );
  });

  test("@journey @security deleting a role with holders waits for the role they move to", async ({
    page,
  }) => {
    const api = signedIn()
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on("POST /api/roles/:roleId/delete", (_r, nth) =>
        nth === 0 ? stepUpRequired("role.delete", { intentId: "sti_delete" }) : ok({}),
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/settings/roles");
    await page.getByRole("button", { name: "More for Developer" }).click();
    await page.getByRole("menuitem", { name: "Delete role" }).click();
    const remove = page.getByRole("dialog", { name: "Delete Developer?" });
    // Super admin may be given, and is first in the list; nothing is chosen for the holders.
    await expect(remove.getByRole("radio", { name: /^Super admin/ })).toBeEnabled();
    await expect(remove.getByRole("radio", { checked: true })).toHaveCount(0);
    const confirm = remove.getByRole("button", { name: "Delete role" });
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(api.calls("POST /api/roles/:roleId/delete")).toHaveLength(0);
    await remove.getByRole("radio", { name: /^Admin/ }).check();
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    await confirm.click();
    await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText(
      "Use your second factor to delete the role Developer.",
    );
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByText("Developer was deleted").first()).toBeVisible();
    const deletes = api.calls("POST /api/roles/:roleId/delete");
    expect(deletes.map((d) => [d.path, d.body])).toEqual([
      ["/api/roles/rol_dev/delete", { moveTo: "admin" }],
      ["/api/roles/rol_dev/delete", { moveTo: "admin" }],
    ]);
    expect(deletes[1]?.headers["fin-step-up-intent"]).toBe("sti_delete");
  });

  test("@journey a copy of Super admin leaves out what can't be given, and saves", async ({
    page,
  }) => {
    const all = BUILT_IN_ROLES[0]?.permissions ?? [];
    const api: ApiDouble = signedIn()
      .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
      .on("GET /api/roles/:roleKey", (request) =>
        request.path.endsWith("/super_admin")
          ? ok({
              roleKey: "super_admin",
              roleId: null,
              label: "Super admin",
              builtIn: true,
              permissions: all,
              version: null,
              holders: 1,
            })
          : ok({
              roleKey: "rol_copy",
              roleId: "rol_copy",
              label: "Super admin copy",
              description: "",
              builtIn: false,
              permissions:
                (api.calls("POST /api/roles")[0]?.body as { permissions?: string[] } | undefined)
                  ?.permissions ?? [],
              version: 1,
              holders: 0,
            }),
      )
      .on("POST /api/roles", ok({ roleId: "rol_copy" }));
    await api.install(page);
    await gotoReady(page, "/settings/roles/new?from=super_admin");
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Super admin copy");
    const restricted = page.getByRole("checkbox", { name: /^Delete the organisation/ });
    await expect(restricted).not.toBeChecked();
    await expect(restricted).toBeDisabled();
    await expect(page.getByText("Some permissions aren’t in the copy.").first()).toBeVisible();
    const save = page.getByRole("button", { name: "Save" });
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
    await save.click();
    await expect(page).toHaveURL(/\/settings\/roles\/rol_copy$/);
    const created = api.calls("POST /api/roles");
    expect(created).toHaveLength(1);
    const sent = (created[0]?.body as { permissions?: string[] } | undefined)?.permissions ?? [];
    expect(sent).not.toContain("organization.delete");
    expect(sent).not.toContain("golive.submit");
    expect(sent.length).toBe(all.length - 2);
  });

  test("@journey an edited role saves with its intent and says it is saved", async ({ page }) => {
    const { api } = developerRoleServer();
    await api.install(page);
    await gotoReady(page, "/settings/roles/rol_dev");
    await expect(page.getByRole("heading", { level: 1, name: "Developer" })).toBeVisible();
    const field = page.getByRole("textbox", { name: /^Description/ });
    await field.fill("Builds the integration.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText(
      "Use your second factor to save the role Developer.",
    );
    await enterCode(page, "Authenticator code", "123456");
    // The save's own reload brings version 2; the editor keeps saying it is saved.
    const summary = page.getByRole("complementary", { name: "Summary" });
    const saved = summary.getByText("Saved. Changes apply on each person’s next request.");
    await expect(saved).toBeVisible();
    await expect(summary.getByText("3 people have this role.")).toBeVisible();
    await expect(saved).toBeVisible();
    await expect(field).toHaveValue("Builds the integration.");
    const saves = api.calls("PUT /api/roles/:roleId");
    expect(saves).toHaveLength(2);
    expect(saves[1]?.body).toMatchObject({ description: "Builds the integration.", version: 1 });
    expect(saves[1]?.headers["fin-step-up-intent"]).toBe("sti_save");

    // A permission changed after the save is not saved yet: the line goes, and Save sends it.
    const customers = page.getByRole("checkbox", { name: /^See customers/ });
    await customers.click();
    await expect(customers).not.toBeChecked();
    await expect(saved).toBeHidden();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(summary.getByText("4 people have this role.")).toBeVisible();
    await expect(saved).toBeVisible();
    await expect(customers).not.toBeChecked();
    const again = api.calls("PUT /api/roles/:roleId");
    expect(again).toHaveLength(3);
    expect(again[2]?.body).toMatchObject({ version: 2 });
    expect(sentPermissions(again[2])).toEqual(["apiKey.read", "member.read", "webhooks.read"]);

    // So is a whole group ticked after a save.
    await page.getByRole("checkbox", { name: /^Customers/ }).click();
    await expect(customers).toBeChecked();
    await expect(saved).toBeHidden();
    expect(api.calls("PUT /api/roles/:roleId")).toHaveLength(3);
  });

  test("@journey a change made while the save reloads is kept and not called saved", async ({
    page,
  }) => {
    const reload = Promise.withResolvers<void>();
    const { api } = developerRoleServer({ nth: 1, until: reload.promise });
    await api.install(page);
    await gotoReady(page, "/settings/roles/rol_dev");
    await expect(page.getByRole("heading", { level: 1, name: "Developer" })).toBeVisible();
    const field = page.getByRole("textbox", { name: /^Description/ });
    await field.fill("Builds the integration.");
    await page.getByRole("button", { name: "Save" }).click();
    await enterCode(page, "Authenticator code", "123456");
    const summary = page.getByRole("complementary", { name: "Summary" });
    const saved = summary.getByText("Saved. Changes apply on each person’s next request.");
    await expect(saved).toBeVisible();
    // The save's reload is still on its way when a permission is unticked.
    await expect.poll(() => api.calls("GET /api/roles/:roleKey").length).toBe(2);
    const customers = page.getByRole("checkbox", { name: /^See customers/ });
    await customers.click();
    await expect(saved).toBeHidden();
    reload.resolve();
    // The reload is drawn (version 2), and the untick is neither lost nor called saved.
    await expect(summary.getByText("3 people have this role.")).toBeVisible();
    await expect(customers).not.toBeChecked();
    await expect(field).toHaveValue("Builds the integration.");
    await expect(saved).toBeHidden();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(summary.getByText("4 people have this role.")).toBeVisible();
    await expect(saved).toBeVisible();
    const saves = api.calls("PUT /api/roles/:roleId");
    expect(saves).toHaveLength(3);
    expect(saves[2]?.body).toMatchObject({ description: "Builds the integration.", version: 2 });
    expect(sentPermissions(saves[2])).toEqual(["apiKey.read", "member.read", "webhooks.read"]);
  });

  test("@journey @security a change made while the save reloads never saves over someone else's", async ({
    page,
  }) => {
    const reload = Promise.withResolvers<void>();
    // Another admin takes webhooks.read away while this editor's reload is on its way.
    const { api, role } = developerRoleServer({
      nth: 1,
      until: reload.promise,
      meanwhile: (held) => {
        held.permissions = held.permissions.filter((key) => key !== "webhooks.read");
        held.version += 1;
      },
    });
    await api.install(page);
    await gotoReady(page, "/settings/roles/rol_dev");
    await expect(page.getByRole("heading", { level: 1, name: "Developer" })).toBeVisible();
    await page.getByRole("textbox", { name: /^Description/ }).fill("Builds the integration.");
    await page.getByRole("button", { name: "Save" }).click();
    await enterCode(page, "Authenticator code", "123456");
    const summary = page.getByRole("complementary", { name: "Summary" });
    const saved = summary.getByText("Saved. Changes apply on each person’s next request.");
    await expect(saved).toBeVisible();
    // The save made version 2; its reload is held while version 3 is made and a box is unticked.
    await expect.poll(() => api.calls("GET /api/roles/:roleKey").length).toBe(2);
    const customers = page.getByRole("checkbox", { name: /^See customers/ });
    await customers.click();
    await expect(saved).toBeHidden();
    reload.resolve();
    await expect(summary.getByText("4 people have this role.")).toBeVisible();
    await expect(customers).not.toBeChecked();

    // The draft was never rebuilt from version 3, so it is saved on version 2 and refused.
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      summary.getByText(
        "Someone else changed this role meanwhile. Reload the page to see their changes.",
      ),
    ).toBeVisible();
    await expect(saved).toBeHidden();
    const saves = api.calls("PUT /api/roles/:roleId");
    expect(saves).toHaveLength(3);
    expect(saves[2]?.body).toMatchObject({ description: "Builds the integration.", version: 2 });
    // The other admin's change stands.
    expect(role.version).toBe(3);
    expect([...role.permissions].sort()).toEqual(["apiKey.read", "customers.read", "member.read"]);
  });
});

/** The permissions a role save sent, sorted. */
function sentPermissions(request: Recorded | undefined): string[] {
  const body = request?.body as { permissions?: string[] } | undefined;
  return [...(body?.permissions ?? [])].sort();
}

/** Developer's role as the stand-in server holds it. */
interface HeldRole {
  description: string;
  permissions: string[];
  version: number;
}

/**
 * Developer's role as a server holds it: a save (after one step-up) at the role's version replaces
 * it, moves its version on and answers with the new version; a save at any other version is refused
 * with `409 conflict`. Each version has its own holders count, so a spec sees when a reload is
 * drawn. `hold` keeps the nth GET of the role waiting until `until` settles; its `meanwhile` is
 * another admin's change, made as that GET arrives.
 */
function developerRoleServer(hold?: {
  nth: number;
  until: Promise<void>;
  meanwhile?: (role: HeldRole) => void;
}): { api: ApiDouble; role: HeldRole } {
  const role: HeldRole = {
    description: DEVELOPER_ROLE.description,
    permissions: [...DEVELOPER_ROLE.permissions],
    version: 1,
  };
  const api = signedIn()
    .on("GET /api/roles", ok({ roles: [...BUILT_IN_ROLES, DEVELOPER_ROLE] }))
    .on("GET /api/roles/:roleKey", async (_request, nth) => {
      if (hold !== undefined && nth === hold.nth) {
        hold.meanwhile?.(role);
        await hold.until;
      }
      return ok({
        roleKey: "rol_dev",
        roleId: "rol_dev",
        label: "Developer",
        description: role.description,
        builtIn: false,
        permissions: role.permissions,
        version: role.version,
        holders: role.version + 1,
      });
    })
    .on("PUT /api/roles/:roleId", (request, nth) => {
      if (nth === 0) return stepUpRequired("role.update", { intentId: "sti_save" });
      const body = request.body as { description: string; permissions: string[]; version: number };
      if (body.version !== role.version) return problem(409, "conflict");
      role.description = body.description;
      role.permissions = body.permissions;
      role.version += 1;
      return ok({ version: role.version });
    })
    .on("POST /api/auth/two-factor/verify-totp", ok({}));
  return { api, role };
}

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
    await expect(page.getByText("Couldn’t load the audit log").first()).toBeVisible();
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
    await expect(page.getByText("Signed out everywhere else").first()).toBeVisible();
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
    await expect(page.getByText("You have no second factor yet.").first()).toBeVisible();
    await expect(
      page
        .getByText("Your account has no name yet. It is shown to your team and in the audit log.")
        .first(),
    ).toBeVisible();
  });

  test("@journey @security one sign-out at a time, and the factor names the device", async ({
    page,
  }) => {
    const api = signedIn()
      .on("GET /api/account/security", ok(SECURITY_DATA))
      .on(
        "GET /api/account/sessions",
        ok({
          items: [
            ...SESSIONS,
            {
              id: "ses_3",
              device: "Firefox on Windows",
              ipAddress: "198.51.100.77",
              createdAt: "2026-11-17T09:14:00Z",
              lastSeenAt: "2026-11-17T09:14:00Z",
              current: false,
            },
          ],
          total: 3,
        }),
      )
      .on("GET /api/account/activity", ok({ items: [], total: 0 }))
      .on("POST /api/account/sessions/:sessionId/revoke", (_r, nth) =>
        nth === 0
          ? {
              ...stepUpRequired("account.session_revoke", { intentId: "sti_session" }),
              delayMs: 1500,
            }
          : ok({}),
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/account/security");
    const sessions = page.getByRole("table", { name: "Where you’re signed in" });
    await sessions
      .getByRole("row", { name: "Safari on iPhone" })
      .getByRole("button", { name: "Sign out" })
      .click();
    // While it runs, the other sign-outs wait for it.
    await expect(
      sessions
        .getByRole("row", { name: "Firefox on Windows" })
        .getByRole("button", { name: "Sign out" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sign out everywhere else" })).toBeDisabled();
    await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText(
      "Use your second factor to sign out Safari on iPhone.",
    );
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByText("Signed out Safari on iPhone").first()).toBeVisible();
    expect(api.calls("POST /api/account/sessions/:sessionId/revoke").map((c) => c.path)).toEqual([
      "/api/account/sessions/ses_2/revoke",
      "/api/account/sessions/ses_2/revoke",
    ]);
  });

  test("@journey @security the authenticator is set up from Account security with the factor", async ({
    page,
  }) => {
    const codes = Array.from({ length: 10 }, (_, i) => `code-${String(i).padStart(4, "0")}`);
    const api = signedIn(
      viewer({ factors: { passkeys: 1, authenticator: false, backupCodesLeft: null } }),
    )
      .on(
        "GET /api/account/security",
        ok({ ...SECURITY_DATA, authenticator: false, backupCodesLeft: null }),
      )
      .on("GET /api/account/sessions", ok({ items: SESSIONS, total: 2 }))
      .on("GET /api/account/activity", ok({ items: [], total: 0 }))
      .on("POST /api/auth/two-factor/enable", (_r, nth) =>
        nth === 0
          ? stepUpRequired("account.totp_enable", {
              intentId: "sti_totp",
              methods: ["passkey"],
            })
          : ok({
              totpURI: "otpauth://totp/Fin:maya?secret=JBSWY3DPEHPK3PXP&issuer=Fin",
              backupCodes: codes,
            }),
      )
      .on("POST /api/auth/passkey/verify-authentication", ok({ session: {} }))
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/account/security");
    await page
      .getByRole("table", { name: "Your sign-in methods" })
      .getByRole("button", { name: "Set up" })
      .click();
    const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
    await expect(stepUp).toContainText("Use your second factor to set up an authenticator app.");
    await expect(stepUp.getByRole("button", { name: "Use your passkey" })).toBeVisible();
    await stepUp.getByRole("button", { name: "Cancel" }).click();
    await expect(stepUp).toHaveCount(0);
    expect(api.calls("POST /api/auth/two-factor/enable")).toHaveLength(1);
    // Asked again, the dialog is proved by a code from the ceremony double.
    api.on("POST /api/auth/two-factor/enable", (_r, nth) =>
      nth === 0
        ? stepUpRequired("account.totp_enable", { intentId: "sti_totp2" })
        : ok({
            totpURI: "otpauth://totp/Fin:maya?secret=JBSWY3DPEHPK3PXP&issuer=Fin",
            backupCodes: codes,
          }),
    );
    await page
      .getByRole("table", { name: "Your sign-in methods" })
      .getByRole("button", { name: "Set up" })
      .click();
    await enterCode(page, "Authenticator code", "123456");
    const setup = page.getByRole("dialog", { name: "Set up your authenticator" });
    await expect(setup.getByTestId("authenticator-key")).toHaveText("JBSW Y3DP EHPK 3PXP");
    expect(
      api.calls("POST /api/auth/two-factor/enable").at(-1)?.headers["fin-step-up-intent"],
    ).toBe("sti_totp2");
    await enterCode(page, "2. Enter the 6-digit code it shows", "654321");
    const saved = page.getByRole("dialog", { name: "Save your backup codes" });
    await expect(
      saved.getByRole("list", { name: "Backup codes" }).getByRole("listitem"),
    ).toHaveCount(10);
  });
});

test.describe("the organisation", () => {
  test("@journey @security an organisation is created with the factor", async ({ page }) => {
    const api = signedIn()
      .on("GET /api/org", ok(ORG_PROFILE))
      .on("GET /api/orgs", ok({ items: [ORG_ROW], total: 1 }))
      .on("POST /api/orgs", (_r, nth) =>
        nth === 0
          ? stepUpRequired("org.create", { intentId: "sti_org" })
          : { status: 200, body: { orgId: "org_labs" }, delayMs: 600 },
      )
      .on("POST /api/auth/two-factor/verify-totp", ok({}));
    await api.install(page);
    await gotoReady(page, "/settings/organisation");
    await page.getByRole("button", { name: "Create organisation" }).click();
    const create = page.getByRole("dialog", { name: "Create an organisation" });
    await create.getByRole("textbox", { name: "Organisation name" }).fill("Acme Labs");
    await create.getByRole("button", { name: "Create organisation" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm it’s you" })).toContainText(
      "Use your second factor to create an organisation.",
    );
    await enterCode(page, "Authenticator code", "123456");
    await expect(create.getByRole("button", { name: "Create organisation" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(page.getByText("Organisation created").first()).toBeVisible();
    const sends = api.calls("POST /api/orgs");
    expect(sends.map((s) => s.body)).toEqual([{ name: "Acme Labs" }, { name: "Acme Labs" }]);
    expect(sends[1]?.headers["idempotency-key"]).toBe(sends[0]?.headers["idempotency-key"]);
    expect(sends[1]?.headers["fin-step-up-intent"]).toBe("sti_org");
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
