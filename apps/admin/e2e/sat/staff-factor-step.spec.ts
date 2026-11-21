// AdminSecondFactor's factor step and AdminSignIn's refusals (spec 02 §6.4, §5.2, §15.3): a member
// with an authenticator signs in by code and is held at "Confirm it's you" until the code is
// right; a member with both factors is offered the passkey first; the code step's short, expired
// and limited codes, and the sending and resend states, each say what happened.
import { expect, test } from "@fin/testing/playwright";
import type { Page, Route } from "@playwright/test";
import {
  authenticatorCode,
  dialogsGone,
  emailedCodeSignIn,
  enrol,
  ORIGIN,
  server,
  throughAccess,
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
  await expect(page.getByText(`Signing in as ${nadia}.`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Use my passkey" })).toHaveCount(0);
  await page.goto("/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);

  const code = page.getByRole("textbox", { name: "Authenticator code" });
  await code.fill("123");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByText("Enter the 6-digit code from your authenticator app.")).toBeVisible();
  const right = await authenticatorCode(key);
  await code.fill(right === "000000" ? "111111" : "000000");
  await expect(page.getByText("That code isn’t right. Check it and try again.")).toBeVisible();
  await code.fill(right);
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  expect(
    (await server.audit()).some(
      (e) => e.event === "staff.signed_in" && JSON.stringify(e).includes("totp"),
    ),
  ).toBe(true);
});

test("@journey a member with both factors is offered the passkey first, and too many tries end it", async ({
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
  // A second factor from Your sign-in, confirmed with the passkey.
  await page.goto("/account");
  await page.getByRole("button", { name: "Add an authenticator app" }).click();
  await page
    .getByRole("dialog", { name: "Confirm it’s you" })
    .getByRole("button", { name: "Use my passkey" })
    .click();
  const add = page.getByRole("dialog", { name: "Add an authenticator app" });
  const key = ((await add.locator("[data-slot=copy-field] .font-mono").textContent()) ?? "").trim();
  await add.getByRole("textbox", { name: "Code from the app" }).fill(await authenticatorCode(key));
  await expect(page.getByText("Authenticator app added")).toBeVisible();
  await logOut(page, nadia);

  await emailedCodeSignIn(page, emailSink, nadia);
  const passkey = page.getByRole("button", { name: "Use my passkey" });
  await expect(passkey).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Authenticator code" })).toBeVisible();

  // The realm's lockout (spec 02 §5.4) ends the attempt: say so, and go back to sign-in.
  await page.route("**/api/auth/two-factor/verify-totp", (route) =>
    route.fulfill({
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ code: "ACCOUNT_TEMPORARILY_LOCKED", message: "locked" }),
    }),
  );
  await page.getByRole("textbox", { name: "Authenticator code" }).fill("123456");
  await expect(page.getByText("Too many wrong tries. Sign in again.")).toBeVisible();
  await expect(passkey).toBeDisabled();
  await page.unroute("**/api/auth/two-factor/verify-totp");
});

test("@journey the code step says a short, expired or limited code, and while it sends", async ({
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
  await expect(page.getByText("Too many codes asked for in the last hour.")).toBeVisible();
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
  await expect(page.getByText("Enter the 8-digit code from the email.")).toBeVisible();

  // Limited: the realm's limit on tries.
  await page.route("**/api/auth/sign-in/email-otp", problemRoute(429, "rate_limited"));
  await box.fill(code);
  await expect(
    page.getByText("Too many wrong tries in the last hour.", { exact: true }),
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
  await expect(page.getByText("That code has expired or was used.")).toBeVisible();
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
    await expect(page.getByText(/^Send a new code in 0:4\d$/)).toBeVisible();
    // One second at a time: each tick of the countdown schedules the next once React has drawn.
    for (let second = 0; second < 46; second += 1) await page.clock.runFor(1000);
    const mark = await emailSink.mark();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByText("We sent a new code.")).toBeVisible();
    await emailSink.waitForCode({ to: nadia, after: mark });
  });
});
