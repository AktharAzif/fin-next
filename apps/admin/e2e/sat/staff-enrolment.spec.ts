// T-SAT-65 (spec 02 §19.3; AC-SAT-17): a pending member's forced enrolment on AdminSecondFactor.
// The enrolment code comes first and works once: a session that signs in again presents it in
// vain, and so does the member once enrolled. The set-up step's own states (a short code, turning
// the authenticator on, a closed passkey prompt) each say what happened. A session that ends inside
// the enrolment (its 10 minutes at aal1 are shorter than the code's 30, spec 02 §6.4, §6.5) goes
// back to sign-in, never to "ask for a new code".
import { expect, test } from "@fin/testing/playwright";
import {
  authenticatorCode,
  ENDED_URL,
  emailedCodeSignIn,
  endNextPasskeyPrompt,
  hold,
  inApp,
  ORIGIN,
  redeemFromPage,
  server,
  shownKey,
  throughAccess,
} from "../support/journey.ts";

test.beforeEach(async () => {
  await server.reset();
});

test("@journey forced enrolment with the enrolment code, which works once", async ({
  page,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await emailedCodeSignIn(page, emailSink, nadia);

  // Pending: the enrolment code first, and nothing else is in reach.
  const heading = page.getByRole("heading", { level: 1, name: "Enter your enrolment code" });
  await expect(heading).toBeVisible();
  await page.goto("/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
  const field = page.getByRole("textbox", { name: "Enrolment code" });
  const next = page.getByRole("button", { name: "Continue" });
  await field.fill("AAAA-AAAA-AAAA-AAAA");
  await next.click();
  await expect(
    inApp(page).getByText("That code didn’t work. Check it and try again."),
  ).toBeVisible();
  await field.fill(enrolmentCode);
  await next.click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a second factor" })).toBeVisible();

  // "Back to sign in" signs out. A new session needs the code again, and it has been used.
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await emailedCodeSignIn(page, emailSink, nadia);
  await expect(heading).toBeVisible();
  await field.fill(enrolmentCode);
  await next.click();
  await expect(
    inApp(page).getByText(
      "That code can’t be used again. Ask the Admin who added you for a new one.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Add a second factor" })).toHaveCount(0);
  // The server refuses it, not only the page.
  expect(await redeemFromPage(page, enrolmentCode)).toEqual({ status: 403, reason: "used" });

  // The operator makes a new code (spec 02 §10.6); the authenticator, with a short code first,
  // then the right one while it is checked.
  const { enrolmentCode: fresh } = await server.bootstrap(nadia);
  await field.fill(fresh);
  await next.click();
  await page.getByRole("button", { name: "Use an authenticator app" }).click();
  const key = await shownKey(page);
  const box = page.getByRole("textbox", { name: "Code from the app" });
  const turnOn = page.getByRole("button", { name: "Turn it on" });
  await box.fill("123");
  await turnOn.click();
  await expect(
    inApp(page).getByText("Enter the 6-digit code from your authenticator app."),
  ).toBeVisible();
  const checking = await hold(page, "**/api/auth/two-factor/verify-totp");
  await box.fill(await authenticatorCode(key));
  await expect(turnOn).toHaveAttribute("aria-busy", "true");
  checking.release();
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();

  // Enrolled: neither code opens anything again.
  for (const code of [enrolmentCode, fresh]) {
    const again = await redeemFromPage(page, code);
    expect(again.status).toBe(403);
    expect(["used", "not_pending"]).toContain(again.reason);
  }
  const events = await server.audit();
  expect(events.filter((e) => e.event === "staff.enrolment_code_redeemed")).toHaveLength(2);
  expect(
    events.some((e) => e.event === "staff.enrolment_refused" && e.metadata.reason === "used"),
  ).toBe(true);
  expect(events.map((e) => e.event)).toContain("staff.factor_enrolled");
});

test("@journey a closed passkey prompt at set-up says so, and the next one adds the passkey", async ({
  page,
  authenticator,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");
  await emailedCodeSignIn(page, emailSink, nadia);
  await page.getByRole("textbox", { name: "Enrolment code" }).fill(enrolmentCode);
  await page.getByRole("button", { name: "Continue" }).click();
  const add = page.getByRole("button", { name: "Add a passkey" });

  await endNextPasskeyPrompt(page, "create");
  await add.click();
  await expect(inApp(page).getByText("The passkey prompt was closed.")).toBeVisible();
  expect(await authenticator.list(authenticator.rpIdFor(ORIGIN))).toHaveLength(0);

  await add.click();
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  expect(await authenticator.list(authenticator.rpIdFor(ORIGIN))).toHaveLength(1);
});

test("@journey a session that ends during enrolment goes back to sign-in, not to a new code", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");
  await emailedCodeSignIn(page, emailSink, nadia);
  const field = page.getByRole("textbox", { name: "Enrolment code" });
  const next = page.getByRole("button", { name: "Continue" });

  // The aal1 session's 10 minutes pass; the code's 30 have not.
  await server.advance(11 * 60);
  await field.fill(enrolmentCode);
  await next.click();
  await expect(page).toHaveURL(ENDED_URL);
  await expect(inApp(page).getByText("You were signed out. Sign in again.")).toBeVisible();
  await expect(inApp(page).getByText("That code has expired", { exact: false })).toHaveCount(0);

  // Signed in again, the same code works (it was never redeemed), and the session then ends inside
  // the enrolment window: adding the passkey goes back to sign-in too.
  await emailedCodeSignIn(page, emailSink, nadia);
  await server.advance(6 * 60);
  await field.fill(enrolmentCode);
  await next.click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a second factor" })).toBeVisible();
  await server.advance(5 * 60);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page).toHaveURL(ENDED_URL);
  await expect(inApp(page).getByText("You were signed out. Sign in again.")).toBeVisible();
  await expect(inApp(page).getByText("Something went wrong on our side.")).toHaveCount(0);
});
