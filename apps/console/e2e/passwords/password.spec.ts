// Passwords in the console (spec 02 §5.7, §15.2's ResetPassword and NewPassword, the SignIn and
// SignUp boards' password states; stretch 2): the built app on the harness's static host under the
// production page policy, with `/api/*` answered by the scripted stand-in so each board state can
// be drawn, and what the client sends asserted (X-Fin-App, the bodies, nothing sent before it
// should be). The journey at the end runs against the real API test server when it is up with
// passwords on, and is skipped (never passed) otherwise.
import { appOrigin, codeFrom, type EmailSinkReader } from "@fin/testing";
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import {
  ApiDouble,
  FACTOR_STEP,
  libraryError,
  noContent,
  ok,
  problem,
  viewer,
} from "../support/api-double.ts";

const OPTIONS = {
  challenge: "Y2hhbGxlbmdlLWZvci1lMmU",
  rpId: "console.localhost",
  allowCredentials: [],
  userVerification: "required",
  timeout: 60000,
};

/** Built at run time: a good password, a common one and a short one for the fields. */
const GOOD = ["harbour", "light", "forty", "two"].join(" ");
const COMMON = ["password", "1234"].join("");
const SHORT = ["correct", "hor"].join("");
const LINK_CODE = "12345678";

/** A signed-out page with passwords on (or off), the viewer read again after a sign-in. */
function signedOut(passwords: boolean, after: () => unknown = () => null): ApiDouble {
  return new ApiDouble()
    .on("GET /api/sign-in/methods", ok({ password: passwords }))
    .on("GET /api/viewer", () => {
      const who = after();
      return who === null ? problem(401, "unauthenticated") : ok(who);
    })
    .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
    .on("GET /api/invitation", noContent());
}

async function toPasswordStep(page: Page, email: string): Promise<void> {
  await gotoReady(page, "/sign-in");
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  // The methods answer comes first; a slow engine under a full run may take a while.
  await expect(page.getByRole("heading", { level: 1, name: "Enter your password" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("signing in with a password", () => {
  test("@journey @security the password step, a wrong password, then the factor step", async ({
    page,
  }) => {
    let signedInNow = false;
    const api = signedOut(true, () => (signedInNow ? FACTOR_STEP : null)).on(
      "POST /api/auth/sign-in/email",
      (_request, nth) => {
        if (nth === 0) return libraryError(401, "INVALID_EMAIL_OR_PASSWORD");
        signedInNow = true;
        return { status: 200, body: { token: "x" }, delayMs: 1500 };
      },
    );
    await api.install(page);
    await toPasswordStep(page, "maya@example.com");
    // Nothing is sent before the person chooses: no code, no password yet.
    expect(api.calls("POST /api/auth/email-otp/send-verification-otp")).toHaveLength(0);
    await expect(page.getByText("maya@example.com ·")).toBeVisible();
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/reset-password",
    );
    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    await expect(password).toHaveAttribute("type", "password");

    await password.fill(["wrong", "horse", "battery"].join(" "));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("That email and password don’t match.").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Just signed up? Confirm your email" }),
    ).toBeVisible();
    // The field is cleared after a wrong try: the password is never kept on the page.
    await expect(password).toHaveValue("");

    await password.fill(GOOD);
    const signIn = page.getByRole("button", { name: "Sign in", exact: true });
    await signIn.click();
    await expect(signIn).toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(/\/sign-in\/two-factor$/);
    const sent = api.calls("POST /api/auth/sign-in/email");
    expect(sent.map((c) => c.body)).toEqual([
      { email: "maya@example.com", password: ["wrong", "horse", "battery"].join(" ") },
      { email: "maya@example.com", password: GOOD },
    ]);
    expect(sent.every((c) => c.headers["x-fin-app"] === "console")).toBe(true);
  });

  test("@journey @security too many wrong passwords pause it, and a refused link says so", async ({
    page,
  }) => {
    const api = signedOut(true)
      .on("POST /api/auth/sign-in/email", (_request, nth) =>
        nth === 0
          ? problem(429, "rate_limited", { retry_after: 60 })
          : problem(429, "rate_limited", { retry_after: 600, reason: "password_paused" }),
      )
      .on("POST /api/auth/email-otp/send-verification-otp", problem(429, "rate_limited"));
    await api.install(page);
    await toPasswordStep(page, "maya@example.com");
    const password = page.getByLabel("Password", { exact: true });
    // The request limit first: too many attempts, a passkey or a link still work.
    await password.fill(GOOD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByText("Too many attempts. Try again in a few minutes.").first(),
    ).toBeVisible();
    // Then the address's pause.
    await password.fill(GOOD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByText("Too many wrong passwords. Try again later.").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Email me a sign-in link", exact: true }).click();
    await expect(
      page.getByText("No sign-in link was sent. Try again later.").first(),
    ).toBeVisible();
    await expect(
      page.getByText("Password sign-in is paused too. You can still use a passkey.").first(),
    ).toBeVisible();
  });

  test("@journey a link instead of the password, and Change goes back with the address", async ({
    page,
  }) => {
    const api = signedOut(true).on(
      "POST /api/auth/email-otp/send-verification-otp",
      ok({ success: true }),
    );
    await api.install(page);
    await toPasswordStep(page, "maya@example.com");
    await page.getByRole("button", { name: "Change" }).click();
    await expect(page.getByRole("textbox", { name: "Work email" })).toHaveValue("maya@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Email me a sign-in link instead" }).click();
    await expect(page).toHaveURL(/\/sign-in\/code$/);
    expect(api.calls("POST /api/auth/email-otp/send-verification-otp").map((c) => c.body)).toEqual([
      { email: "maya@example.com", type: "sign-in" },
    ]);
  });

  test("@journey with passwords off, Continue sends the emailed code as before", async ({
    page,
  }) => {
    const api = signedOut(false).on(
      "POST /api/auth/email-otp/send-verification-otp",
      ok({ success: true }),
    );
    await api.install(page);
    await gotoReady(page, "/sign-in");
    await page.getByRole("textbox", { name: "Work email" }).fill("maya@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/sign-in\/code$/);
    expect(api.calls("POST /api/auth/sign-in/email")).toHaveLength(0);
  });
});

test.describe("signing up with a password", () => {
  test("@journey too short and too common are said on the field, then the account is asked", async ({
    page,
  }) => {
    const api = signedOut(true).on("POST /api/sign-up", (_request, nth) =>
      nth === 0
        ? problem(400, "invalid", { fields: ["password"], problem: "password_common" })
        : { status: 202, body: { status: "code_sent" } },
    );
    await api.install(page);
    await gotoReady(page, "/sign-up");
    await page.getByRole("textbox", { name: "Full name" }).fill("Maya Rivera");
    await page.getByRole("textbox", { name: "Work email" }).fill("maya@example.com");
    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toHaveAttribute("autocomplete", "new-password");
    await expect(page.getByText("At least 12 characters.")).toBeVisible();

    await password.fill(SHORT);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("2 more characters needed.").first()).toBeVisible();
    expect(api.calls("POST /api/sign-up")).toHaveLength(0);

    await password.fill(COMMON);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("That password is too common. Choose one that’s harder to guess.").first(),
    ).toBeVisible();

    await password.fill(GOOD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/verify-email$/);
    expect(api.calls("POST /api/sign-up").map((c) => c.body)).toEqual([
      { name: "Maya Rivera", email: "maya@example.com", password: COMMON },
      { name: "Maya Rivera", email: "maya@example.com", password: GOOD },
    ]);
  });

  test("@journey with passwords off, the form has no password field", async ({ page }) => {
    const api = signedOut(false);
    await api.install(page);
    await gotoReady(page, "/sign-up");
    await expect(page.getByRole("textbox", { name: "Work email" })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  });
});

test.describe("resetting a password", () => {
  test("@journey @security the same answer for every address, and a wait before another link", async ({
    page,
  }) => {
    const api = signedOut(true).on("POST /api/auth/email-otp/request-password-reset", {
      status: 200,
      body: { success: true },
      delayMs: 1500,
    });
    await api.install(page);
    await gotoReady(page, "/reset-password");
    await expect(
      page.getByRole("heading", { level: 1, name: "Reset your password" }),
    ).toBeVisible();
    await expect(
      page.getByText("Signed up with Google or a passkey? You may not have a password"),
    ).toBeVisible();
    const email = page.getByRole("textbox", { name: "Work email" });
    await email.fill("maya@acme");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("That email address doesn’t look right.").first()).toBeVisible();
    expect(api.calls("POST /api/auth/email-otp/request-password-reset")).toHaveLength(0);

    await email.fill("maya@example.com");
    const send = page.getByRole("button", { name: "Send reset link" });
    await send.click();
    await expect(send).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
    await expect(page.getByText("has a Fin account, we sent a link")).toContainText(
      "maya@example.com",
    );
    await expect(page.getByRole("button", { name: /^Send a new link in 0:4\d$/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(
      page.getByText("We show this message whether or not the email has an account"),
    ).toBeVisible();
    const sent = api.calls("POST /api/auth/email-otp/request-password-reset");
    expect(sent.map((c) => c.body)).toEqual([{ email: "maya@example.com" }]);
    expect(sent[0]?.headers["x-fin-app"]).toBe("console");
  });

  test("@journey too many emails, from the forgot-password link with the address kept", async ({
    page,
  }) => {
    const api = signedOut(true).on(
      "POST /api/auth/email-otp/request-password-reset",
      problem(429, "rate_limited", { retry_after: 60 }),
    );
    await api.install(page);
    await toPasswordStep(page, "maya@example.com");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByRole("textbox", { name: "Work email" })).toHaveValue("maya@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(
      page.getByText("Too many emails were sent to this address. Try again later.").first(),
    ).toBeVisible();
  });

  test("@journey @security the link in the browser that asked: the rule, a wrong code, then saved and signed in", async ({
    page,
  }) => {
    let signedInNow = false;
    const api = signedOut(true, () => (signedInNow ? viewer() : null))
      .on("POST /api/reset-password/code-link", ok({ state: "asking" }))
      .on("POST /api/auth/email-otp/reset-password", (_request, nth) => {
        if (nth === 0)
          return problem(400, "invalid", { fields: ["password"], problem: "password_common" });
        if (nth === 1) return libraryError(400, "INVALID_OTP");
        return { status: 200, body: { success: true }, delayMs: 1500 };
      })
      .on("POST /api/auth/sign-in/email", () => {
        signedInNow = true;
        return ok({ token: "x" });
      });
    await api.install(page);
    await gotoReady(page, `/reset-password/new#e=maya%40example.com&c=${LINK_CODE}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Choose a new password" }),
    ).toBeVisible();
    // The fragment is read once and taken out of the address bar; the code is never in a path.
    expect(new URL(page.url()).hash).toBe("");
    expect(new URL(page.url()).pathname).toBe("/reset-password/new");
    await expect(page.getByText("For maya@example.com.")).toBeVisible();
    await expect(
      page.getByText("Saving signs you out on every other device.").first(),
    ).toBeVisible();
    expect(api.calls("POST /api/reset-password/code-link").map((c) => c.body)).toEqual([
      { email: "maya@example.com" },
    ]);

    const field = page.getByLabel("New password", { exact: true });
    await field.fill(SHORT.slice(0, 9));
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await expect(page.getByText("3 more characters needed.").first()).toBeVisible();
    expect(api.calls("POST /api/auth/email-otp/reset-password")).toHaveLength(0);

    await field.fill(COMMON);
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await expect(
      page.getByText("That password is too common. Choose one that’s harder to guess.").first(),
    ).toBeVisible();

    await field.fill(GOOD);
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await expect(page.getByText("That code didn’t work.").first()).toBeVisible();

    const save = page.getByRole("button", { name: "Save and sign in" });
    await save.click();
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/auth/email-otp/reset-password").at(-1)?.body).toEqual({
      email: "maya@example.com",
      otp: LINK_CODE,
      password: GOOD,
    });
    expect(api.calls("POST /api/auth/sign-in/email").map((c) => c.body)).toEqual([
      { email: "maya@example.com", password: GOOD },
    ]);
  });

  test("@journey @security a link opened in another browser, or without its code, cannot be used", async ({
    page,
  }) => {
    const api = signedOut(true).on(
      "POST /api/reset-password/code-link",
      ok({ state: "elsewhere" }),
    );
    await api.install(page);
    await gotoReady(page, `/reset-password/new#e=maya%40example.com&c=${LINK_CODE}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "This link can’t be used here" }),
    ).toBeVisible();
    await expect(
      page
        .getByText("This link was opened in a different browser from the one that asked for it.")
        .first(),
    ).toBeVisible();
    expect(api.calls("POST /api/auth/email-otp/reset-password")).toHaveLength(0);
    await page.getByRole("button", { name: "Send a new link" }).click();
    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByRole("textbox", { name: "Work email" })).toHaveValue("maya@example.com");

    await gotoReady(page, "/reset-password/new");
    await expect(
      page.getByRole("heading", { level: 1, name: "This link can’t be used" }),
    ).toBeVisible();
    await expect(
      page.getByText("It has expired, was already used, or was opened without its code.").first(),
    ).toBeVisible();
  });

  test("@journey with passwords off, the reset pages are not found", async ({ page }) => {
    const api = signedOut(false);
    await api.install(page);
    await gotoReady(page, "/reset-password");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await page.getByRole("button", { name: "Go to sign in" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

// Against the real API test server (STATIC_APPS.console.apiPort), with passwords on.
test.describe("the password journey on the real API", () => {
  const ORIGIN = appOrigin("console");

  async function ready(page: Page): Promise<boolean> {
    try {
      const health = await page.request.get(`${ORIGIN}/api/health`, { timeout: 5000 });
      if (!health.ok()) return false;
      const methods = await page.request.get(`${ORIGIN}/api/sign-in/methods`, { timeout: 5000 });
      return methods.ok() && (await methods.json()).password === true;
    } catch {
      return false;
    }
  }

  async function codeFor(sink: EmailSinkReader, email: string, after: number): Promise<string> {
    return codeFrom(await sink.waitFor({ to: email, after }, { timeoutMs: 15_000 }));
  }

  test("@journey sign up with a password, reset it by the emailed link, sign in with the new one", async ({
    page,
    emailSink,
    addresses,
  }) => {
    test.skip(
      !(await ready(page)),
      "the console's API test server is not running with passwords on (FIN_FEATURE_PASSWORDS)",
    );
    const email = addresses.fresh("maya");
    let mark = await emailSink.mark();
    await gotoReady(page, "/sign-up");
    await page.getByRole("textbox", { name: "Full name" }).fill("Maya Rivera");
    await page.getByRole("textbox", { name: "Work email" }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(GOOD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/verify-email$/);
    const confirm = page.getByRole("textbox", { name: "Confirmation code" });
    await confirm.focus();
    await confirm.fill(await codeFor(emailSink, email, mark));
    await expect(page).toHaveURL(/\/welcome\/secure/);

    mark = await emailSink.mark();
    await gotoReady(page, "/reset-password");
    await page.getByRole("textbox", { name: "Work email" }).fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
    const code = await codeFor(emailSink, email, mark);
    const better = ["a", "quiet", "lighthouse", "at", "dusk"].join(" ");
    await gotoReady(page, `/reset-password/new#e=${encodeURIComponent(email)}&c=${code}`);
    await page.getByLabel("New password", { exact: true }).fill(better);
    await page.getByRole("button", { name: "Save and sign in" }).click();
    // Signed in again with the new password, held at "Protect your account" (no factor yet).
    await expect(page).toHaveURL(/\/welcome\/secure/);
  });
});
