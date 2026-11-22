// The StepUp dialog, "Confirm it's you", in every state (spec 02 §7.1 to §7.7, §15.2's StepUp row):
// the built app under the production page policy, with `/api/*` answered by the scripted stand-in
// (support/api-double.ts). Account security's "Sign out everywhere else" asks for the factor; each
// test drives one way through the dialog and asserts what the client sent: the proof and the one
// re-send carry the intent, and nothing is sent again after a failure (the dialog never loops).
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import {
  ApiDouble,
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

const ACTION = "POST /api/account/sessions/revoke-others";
const TOTP = "POST /api/auth/two-factor/verify-totp";
const BACKUP = "POST /api/auth/two-factor/verify-backup-code";
const DONE = "Signed out everywhere else";

/** Account security with one other session, ready for "Sign out everywhere else". */
function securityPage(): ApiDouble {
  return new ApiDouble()
    .on("GET /api/viewer", ok(viewer()))
    .on(
      "GET /api/account/security",
      ok({
        name: "Maya Rivera",
        email: "maya@example.com",
        passkeys: [{ id: "pky_1", name: "Chrome on Mac", createdAt: "2026-11-02T10:05:00Z" }],
        authenticator: true,
        backupCodesLeft: 8,
        trustedBrowsers: [],
        noSecondFactor: false,
      }),
    )
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
    .on("GET /api/account/activity", ok({ items: [], total: 0 }));
}

async function enterCode(page: Page, label: string, code: string): Promise<void> {
  const input = page.getByRole("textbox", { name: label });
  await input.focus();
  await input.fill(code);
}

async function signOutOthers(page: Page): Promise<void> {
  await gotoReady(page, "/account/security");
  await expect(page.getByRole("table", { name: "Where you’re signed in" })).toContainText(
    "Safari on iPhone",
  );
  await page.getByRole("button", { name: "Sign out everywhere else" }).click();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Confirm it’s you" });

test.describe("the StepUp dialog", () => {
  test("@journey @security a wrong code is said, then the right one proves the intent once", async ({
    page,
  }) => {
    const api = securityPage()
      .on(ACTION, (_r, nth) =>
        nth === 0
          ? stepUpRequired("account.sessions_revoke_others", { intentId: "sti_a" })
          : ok({ revoked: 1 }),
      )
      .on(TOTP, (_r, nth) => (nth === 0 ? libraryError(401, "INVALID_CODE") : ok({})));
    await api.install(page);
    await signOutOthers(page);
    await expect(dialog(page)).toContainText(
      "Use your second factor to sign out your other devices.",
    );
    await enterCode(page, "Authenticator code", "000000");
    await expect(dialog(page).getByText("That code isn’t right.", { exact: true })).toBeVisible();
    // A wrong code proves nothing: the action is not sent again.
    expect(api.calls(ACTION)).toHaveLength(1);
    await enterCode(page, "Authenticator code", "123456");
    await expect(page.getByText(DONE).first()).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    const proofs = api.calls(TOTP);
    expect(proofs.map((p) => p.body)).toEqual([{ code: "000000" }, { code: "123456" }]);
    expect(proofs.every((p) => p.headers["fin-step-up-intent"] === "sti_a")).toBe(true);
    const sends = api.calls(ACTION);
    expect(sends).toHaveLength(2);
    expect(sends[1]?.headers["fin-step-up-intent"]).toBe("sti_a");
  });

  test("@journey @security a backup code, after a wrong one", async ({ page }) => {
    const api = securityPage()
      .on(ACTION, (_r, nth) =>
        nth === 0
          ? stepUpRequired("account.sessions_revoke_others", { intentId: "sti_b" })
          : ok({ revoked: 1 }),
      )
      .on(BACKUP, (_r, nth) => (nth === 0 ? libraryError(401, "INVALID_BACKUP_CODE") : ok({})));
    await api.install(page);
    await signOutOthers(page);
    await dialog(page).getByRole("button", { name: "Enter a backup code" }).click();
    const field = dialog(page).getByRole("textbox", { name: "Backup code" });
    await field.fill("wrong-0000");
    await dialog(page).getByRole("button", { name: "Verify backup code" }).click();
    await expect(dialog(page).getByText("That backup code isn’t right.")).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    expect(api.calls(ACTION)).toHaveLength(1);
    await field.fill("code-0001");
    await dialog(page).getByRole("button", { name: "Verify backup code" }).click();
    await expect(page.getByText(DONE).first()).toBeVisible();
    expect(api.calls(BACKUP).map((p) => p.body)).toEqual([
      { code: "wrong-0000" },
      { code: "code-0001" },
    ]);
    expect(api.calls(BACKUP)[1]?.headers["fin-step-up-intent"]).toBe("sti_b");
    expect(api.calls(ACTION)[1]?.headers["fin-step-up-intent"]).toBe("sti_b");
    expect(api.calls(TOTP)).toHaveLength(0);
  });

  test("@journey @security paused codes are said and can't be tried again", async ({ page }) => {
    const api = securityPage()
      .on(ACTION, stepUpRequired("account.sessions_revoke_others", { intentId: "sti_p" }))
      .on(TOTP, libraryError(403, "ACCOUNT_TEMPORARILY_LOCKED"));
    await api.install(page);
    await signOutOthers(page);
    await enterCode(page, "Authenticator code", "123456");
    await expect(
      dialog(page).locator("p", {
        hasText: "Your authenticator and backup codes are paused for an hour.",
      }),
    ).toBeVisible();
    await expect(dialog(page).getByRole("textbox", { name: "Authenticator code" })).toBeDisabled();
    await expect(dialog(page).getByRole("button", { name: "Verify code" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(dialog(page).getByRole("button", { name: "Enter a backup code" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(api.calls(TOTP)).toHaveLength(1);
    expect(api.calls(ACTION)).toHaveLength(1);
  });

  test("@journey @security a refused or failed re-send is said once, never sent again", async ({
    page,
  }) => {
    const api = securityPage()
      .on(ACTION, (_r, nth) => {
        if (nth === 0)
          return stepUpRequired("account.sessions_revoke_others", { intentId: "sti_1" });
        if (nth === 1) return problem(403, "step_up_invalid");
        if (nth === 2)
          return stepUpRequired("account.sessions_revoke_others", { intentId: "sti_2" });
        return problem(500, "internal");
      })
      .on(TOTP, ok({}));
    await api.install(page);
    await signOutOthers(page);
    await enterCode(page, "Authenticator code", "123456");
    await expect(dialog(page).getByText("That didn’t work. Try again.")).toBeVisible();
    await expect(dialog(page).getByRole("textbox", { name: "Authenticator code" })).toHaveCount(0);
    // The intent was refused after the proof: one re-send, and nothing after it.
    await page.waitForTimeout(300);
    expect(api.calls(ACTION)).toHaveLength(2);
    expect(api.calls(ACTION)[1]?.headers["fin-step-up-intent"]).toBe("sti_1");
    await dialog(page).locator("button", { hasText: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText("Couldn’t sign out your other devices")).toHaveCount(0);

    // Done again, and this time the re-send fails on Fin's side.
    await page.getByRole("button", { name: "Sign out everywhere else" }).click();
    await enterCode(page, "Authenticator code", "654321");
    await expect(dialog(page).getByText("That didn’t go through.")).toBeVisible();
    await page.waitForTimeout(300);
    expect(api.calls(ACTION)).toHaveLength(4);
    expect(api.calls(ACTION)[3]?.headers["fin-step-up-intent"]).toBe("sti_2");
    await dialog(page).locator("button", { hasText: "Close" }).click();
    await expect(page.getByText("Couldn’t sign out your other devices").first()).toBeVisible();
  });

  test("@journey @security a session ended by too many tries goes to the sign-in page", async ({
    page,
  }) => {
    let ended = false;
    const api = securityPage()
      .on("GET /api/viewer", () => (ended ? problem(401, "unauthenticated") : ok(viewer())))
      .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
      .on(ACTION, stepUpRequired("account.sessions_revoke_others", { intentId: "sti_t" }))
      .on(TOTP, () => {
        ended = true;
        return problem(401, "unauthenticated");
      });
    await api.install(page);
    await signOutOthers(page);
    await enterCode(page, "Authenticator code", "000000");
    await expect(page).toHaveURL(/\/sign-in\?error=too_many_tries$/);
    await expect(
      page.getByText("You were signed out after too many wrong tries.").first(),
    ).toBeVisible();
    expect(api.calls(ACTION)).toHaveLength(1);
  });

  test("@journey @security a passkey: waiting, none used, refused, then proved", async ({
    page,
    authenticator,
  }) => {
    const api = securityPage()
      .on(ACTION, (_r, nth) =>
        nth === 0
          ? stepUpRequired("account.sessions_revoke_others", {
              intentId: "sti_k",
              methods: ["passkey", "authenticator", "backup_code"],
            })
          : ok({ revoked: 1 }),
      )
      .on("GET /api/auth/passkey/generate-authenticate-options", {
        status: 200,
        // A short prompt: with no passkey to offer, it ends with none used.
        body: { ...OPTIONS, timeout: 1500 },
        delayMs: 600,
      })
      .on("POST /api/auth/passkey/verify-authentication", (_r, nth) =>
        nth === 0 ? libraryError(401, "AUTHENTICATION_FAILED") : ok({ session: {} }),
      );
    await api.install(page);
    await signOutOthers(page);
    const passkey = dialog(page).getByRole("button", { name: "Use your passkey" });
    await passkey.click();
    // Waiting for the browser's prompt: the button is busy, the codes wait.
    await expect(passkey).toHaveAttribute("aria-busy", "true");
    await expect(dialog(page).getByRole("button", { name: "Verify code" })).toBeDisabled();
    // The authenticator holds no passkey for this site: none was used.
    await expect(dialog(page).getByText("No passkey was used.")).toBeVisible({ timeout: 10_000 });
    expect(api.calls("POST /api/auth/passkey/verify-authentication")).toHaveLength(0);

    await authenticator.seed(authenticator.rpIdFor(page.url()));
    await passkey.click();
    await expect(dialog(page).getByText("That passkey didn’t work.")).toBeVisible();
    expect(api.calls(ACTION)).toHaveLength(1);
    await passkey.click();
    await expect(page.getByText(DONE).first()).toBeVisible();
    const verified = api.calls("POST /api/auth/passkey/verify-authentication");
    expect(verified).toHaveLength(2);
    expect(verified.every((v) => v.headers["fin-step-up-intent"] === "sti_k")).toBe(true);
    expect(api.calls(ACTION)[1]?.headers["fin-step-up-intent"]).toBe("sti_k");
  });

  test("@journey a browser that can't use passkeys is told so", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "PublicKeyCredential", { value: undefined });
    });
    const api = securityPage().on(
      ACTION,
      stepUpRequired("account.sessions_revoke_others", { intentId: "sti_n", methods: ["passkey"] }),
    );
    await api.install(page);
    await signOutOthers(page);
    await expect(dialog(page).getByText("This browser can’t use passkeys.")).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Use your passkey" })).toHaveCount(0);
  });

  test("@journey the gates: a second factor first, then a sign-in by email", async ({ page }) => {
    const api = securityPage()
      .on(ACTION, (_r, nth) =>
        nth === 0
          ? problem(403, "second_factor_required", { hold: false })
          : problem(403, "fresh_session_required"),
      )
      .on("POST /api/auth/email-otp/send-verification-otp", (_r, nth) =>
        nth === 0 ? { fail: true } : ok({ success: true }),
      );
    await api.install(page);
    await signOutOthers(page);
    const first = page.getByRole("dialog", { name: "Add a second factor first" });
    await expect(first).toBeVisible();
    await expect(first.getByRole("link", { name: "Open Account security" })).toHaveAttribute(
      "href",
      "/account/security",
    );
    await first.getByRole("button", { name: "Not now" }).click();
    await expect(first).toHaveCount(0);
    await expect(page.getByText("Couldn’t sign out your other devices")).toHaveCount(0);

    await page.getByRole("button", { name: "Sign out everywhere else" }).click();
    const byEmail = page.getByRole("dialog", { name: "Sign in by email to add a second factor" });
    await expect(byEmail).toBeVisible();
    await byEmail.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(byEmail.getByText("The email couldn’t be sent.")).toBeVisible();
    await byEmail.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page).toHaveURL(/\/sign-in\/code\?next=%2Faccount%2Fsecurity$/);
    const sent = api.calls("POST /api/auth/email-otp/send-verification-otp");
    expect(sent.at(-1)?.body).toEqual({ email: "maya@example.com", type: "sign-in" });
    // Neither gate proves anything: the action was never sent with an intent.
    expect(api.calls(ACTION).every((c) => c.headers["fin-step-up-intent"] === undefined)).toBe(
      true,
    );
  });
});
