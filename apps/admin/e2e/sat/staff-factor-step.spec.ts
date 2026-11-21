// AdminSecondFactor's factor step and AdminSignIn's refusals (spec 02 §6.4, §5.2, §15.3): a member
// with an authenticator signs in by code and is held at "Confirm it's you" until the code is
// right; a member with both factors is offered the passkey first, and the realm's lockout on codes
// (spec 02 §5.4) stops the codes without signing anyone out; a member with a passkey alone passes
// the step with it; a browser without passkeys uses the authenticator; the code step's short,
// expired and limited codes, and the sending, verifying and resend states, each say what happened.
import type { EmailSinkReader } from "@fin/testing";
import { expect, test } from "@fin/testing/playwright";
import type { Page, Route } from "@playwright/test";
import {
  authenticatorCode,
  dialogsGone,
  emailedCodeSignIn,
  endNextPasskeyPrompt,
  enrol,
  hold,
  inApp,
  ORIGIN,
  server,
  throughAccess,
  tryCode,
  viewerState,
  withoutPasskeys,
  wrongCodes,
} from "../support/journey.ts";

test.beforeEach(async () => {
  await server.reset();
});

async function logOut(page: Page, email: string) {
  await dialogsGone(page);
  await page.getByRole("button", { name: `Account menu, ${email}` }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
}

/**
 * The first Admin with both factors: a passkey at enrolment, then an authenticator from Your
 * sign-in, confirmed with the passkey. Ends signed out; returns the authenticator's key.
 */
async function withBothFactors(
  page: Page,
  emailSink: EmailSinkReader,
  email: string,
): Promise<string> {
  const { enrolmentCode } = await server.bootstrap(email);
  await throughAccess(page, email, "/sign-in");
  await emailedCodeSignIn(page, emailSink, email);
  await enrol(page, enrolmentCode, "passkey");
  await page.goto("/account");
  await page.getByRole("button", { name: "Add an authenticator app" }).click();
  await page
    .getByRole("dialog", { name: "Confirm it’s you" })
    .getByRole("button", { name: "Use my passkey" })
    .click();
  const add = page.getByRole("dialog", { name: "Add an authenticator app" });
  const key = ((await add.locator("[data-slot=copy-field] .font-mono").textContent()) ?? "").trim();
  await add.getByRole("textbox", { name: "Code from the app" }).fill(await authenticatorCode(key));
  await expect(inApp(page).getByText("Authenticator app added")).toBeVisible();
  await logOut(page, email);
  return key;
}

function problemRoute(status: number, code: string, extra: Record<string, unknown> = {}) {
  return (route: Route) =>
    route.fulfill({
      status,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      body: JSON.stringify({
        type: `https://docs.localhost/errors/${code}`,
        title: code,
        status,
        code,
        request_id: "req_e2e",
        ...extra,
      }),
    });
}

test("@journey a code sign-in is held at the factor step until the authenticator's code is right", async ({
  page,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");
  await emailedCodeSignIn(page, emailSink, nadia);
  const key = (await enrol(page, enrolmentCode, "authenticator")) as string;
  await logOut(page, nadia);

  // An emailed code alone is aal1: the factor step, and Staff is out of reach.
  await emailedCodeSignIn(page, emailSink, nadia);
  await expect(page.getByRole("heading", { level: 1, name: "Confirm it’s you" })).toBeVisible();
  await expect(inApp(page).getByText(`Signing in as ${nadia}.`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Use my passkey" })).toHaveCount(0);
  await page.goto("/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);

  const code = page.getByRole("textbox", { name: "Authenticator code" });
  await code.fill("123");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(
    inApp(page).getByText("Enter the 6-digit code from your authenticator app."),
  ).toBeVisible();
  const right = await authenticatorCode(key);
  await code.fill(right === "000000" ? "111111" : "000000");
  await expect(
    inApp(page).getByText("That code isn’t right. Check it and try again."),
  ).toBeVisible();
  await code.fill(right);
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  expect(
    (await server.audit()).some(
      (e) => e.event === "staff.signed_in" && JSON.stringify(e).includes("totp"),
    ),
  ).toBe(true);
});

test("@journey a member with both factors is offered the passkey first, and the lockout stops codes but signs nobody out", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const key = await withBothFactors(page, emailSink, nadia);

  await emailedCodeSignIn(page, emailSink, nadia);
  const passkey = page.getByRole("button", { name: "Use my passkey" });
  const box = page.getByRole("textbox", { name: "Authenticator code" });
  const verify = page.getByRole("button", { name: "Verify and continue" });
  await expect(passkey).toBeVisible();
  await expect(box).toBeVisible();

  // The realm's own lockout (spec 02 §5.4): ten wrong codes, then it refuses codes for an hour.
  const codes = await wrongCodes(key, 11);
  for (const [index, code] of codes.entries()) {
    const answer = await tryCode(page, box, verify, code);
    if (index < 10) expect(answer).toMatchObject({ status: 401, code: "INVALID_CODE" });
    else expect(answer).toMatchObject({ status: 429, code: "ACCOUNT_TEMPORARILY_LOCKED" });
  }
  await expect(inApp(page).getByText("Too many wrong tries.", { exact: true })).toBeVisible();
  await expect(inApp(page).getByText("Try again later.", { exact: true })).toBeVisible();
  await expect(inApp(page).getByText("signs you out", { exact: false })).toHaveCount(0);
  await expect(box).toBeDisabled();
  await expect(verify).toHaveAttribute("aria-disabled", "true");

  // The lockout ends no session, so the page claims none: it stays where it is, still at the
  // factor step, and the passkey (not a code) still finishes it.
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
  expect(await viewerState(page)).toBe("factor_step");
  await expect(passkey).toBeEnabled();
  await passkey.click();
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
});

test("@journey a member with a passkey alone passes the factor step with it", async ({
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
  await logOut(page, nadia);

  // An emailed code alone is aal1: "Confirm it's you" with the passkey, and no code to type.
  await emailedCodeSignIn(page, emailSink, nadia);
  await expect(page.getByRole("heading", { level: 1, name: "Confirm it’s you" })).toBeVisible();
  const passkey = page.getByRole("button", { name: "Use my passkey" });
  await expect(passkey).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Authenticator code" })).toHaveCount(0);

  // The prompt closed by the person, then refused by the authenticator: each says so.
  await endNextPasskeyPrompt(page, "get");
  await passkey.click();
  await expect(inApp(page).getByText("The passkey prompt was closed.")).toBeVisible();
  await endNextPasskeyPrompt(page, "get", "UnknownError");
  await passkey.click();
  await expect(inApp(page).getByText("There’s no passkey to use.")).toBeVisible();
  await expect(inApp(page).getByText("Try the passkey on another device.")).toBeVisible();

  // While the prompt is open the button waits; the passkey raises the session to aal2.
  const prompt = await hold(page, "**/api/auth/passkey/generate-authenticate-options");
  await passkey.click();
  await expect(passkey).toHaveAttribute("aria-busy", "true");
  prompt.release();
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  const signedIn = (await server.audit()).filter(
    (e) => e.event === "staff.signed_in" && e.metadata.method === "passkey",
  );
  expect(signedIn.length).toBeGreaterThanOrEqual(2);
});

test("@journey a browser without passkeys uses the authenticator at the factor step", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const key = await withBothFactors(page, emailSink, nadia);
  await withoutPasskeys(page);
  await page.reload();

  await emailedCodeSignIn(page, emailSink, nadia);
  await expect(inApp(page).getByText("This browser can’t use passkeys.")).toBeVisible();
  await expect(inApp(page).getByText("Use your authenticator app.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use my passkey" })).toHaveCount(0);

  // The code is checked while the button waits.
  const verify = page.getByRole("button", { name: "Verify and continue" });
  const checking = await hold(page, "**/api/auth/two-factor/verify-totp");
  await page
    .getByRole("textbox", { name: "Authenticator code" })
    .fill(await authenticatorCode(key));
  await expect(verify).toHaveAttribute("aria-busy", "true");
  checking.release();
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
});

test("@journey the code step says a short, expired or limited code, and while it sends and checks", async ({
  page,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");

  // Too many codes: the realm's limit on sending.
  await page.route(
    "**/api/auth/email-otp/send-verification-otp",
    problemRoute(429, "rate_limited", { retry_after: 600 }),
  );
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(inApp(page).getByText("Too many codes asked for in the last hour.")).toBeVisible();
  await page.unroute("**/api/auth/email-otp/send-verification-otp");

  // Sending: the button is busy until the realm answers.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/email-otp/send-verification-otp", async (route) => {
    await held;
    await route.fallback();
  });
  const mark = await emailSink.mark();
  const send = page.getByRole("button", { name: "Email me a code" });
  await send.click();
  await expect(send).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  await page.unroute("**/api/auth/email-otp/send-verification-otp");
  const code = await emailSink.waitForCode({ to: nadia, after: mark });

  // Short: nothing is sent.
  const box = page.getByRole("textbox", { name: "Sign-in code" });
  await box.fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(inApp(page).getByText("Enter the 8-digit code from the email.")).toBeVisible();

  // Limited: the realm's limit on tries.
  await page.route("**/api/auth/sign-in/email-otp", problemRoute(429, "rate_limited"));
  await box.fill(code);
  await expect(
    inApp(page).getByText("Too many wrong tries in the last hour.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.unroute("**/api/auth/sign-in/email-otp");

  // Expired: ten minutes on the server's clock.
  await page.getByRole("button", { name: "Use another address" }).click();
  const again = await emailSink.mark();
  await page.getByRole("button", { name: "Email me a code" }).click();
  const fresh = await emailSink.waitForCode({ to: nadia, after: again });
  await server.advance(11 * 60);
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(fresh);
  await expect(inApp(page).getByText("That code has expired or was used.")).toBeVisible();

  // Verifying: the button waits while the realm checks a new code, which then signs in.
  await page.getByRole("button", { name: "Use another address" }).click();
  const last = await emailSink.mark();
  await page.getByRole("button", { name: "Email me a code" }).click();
  const newest = await emailSink.waitForCode({ to: nadia, after: last });
  const checking = await hold(page, "**/api/auth/sign-in/email-otp");
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(newest);
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveAttribute("aria-busy", "true");
  checking.release();
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
});

test.describe("the resend countdown", () => {
  test.use({ clockMode: "paused" });

  test("@journey a new code after 45 seconds, and the page says it was sent", async ({
    page,
    emailSink,
    addresses,
  }) => {
    const nadia = addresses.address("nadia.brooks");
    await server.bootstrap(nadia);
    await throughAccess(page, nadia, "/sign-in");
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(inApp(page).getByText(/^Send a new code in 0:4\d$/)).toBeVisible();
    // One second at a time: each tick of the countdown schedules the next once React has drawn.
    for (let second = 0; second < 46; second += 1) await page.clock.runFor(1000);
    const mark = await emailSink.mark();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(inApp(page).getByText("We sent a new code.")).toBeVisible();
    await emailSink.waitForCode({ to: nadia, after: mark });
  });
});
