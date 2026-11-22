// Staff Google on AdminSignIn (stretch 5, spec 02 §5.8; spec 06's googleFailed and noGoogle): the
// card offers "Continue with Google" only while staff Google is on; a round trip by a member is a
// first factor only, landing on enrolment (or the factor step), never in Fin Admin; a refused one
// comes back to the card and says so, with no session. The realm's own rules are proven against
// the fixture OpenID provider by src/server/google.db.test.ts; here the API stand-in keeps them.
import { expect, test, waitForReady } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import { enrol, inApp, ORIGIN, server, throughAccess, viewerState } from "../support/journey.ts";

test.beforeEach(async () => {
  await server.reset();
});

const GOOGLE = { name: "Continue with Google" };

/** Presses "Continue with Google" and waits for the round trip's page to be ready again. */
async function continueWithGoogle(page: Page): Promise<void> {
  const back = page.waitForResponse((r) => r.url().includes("/api/auth/callback/google"));
  await page.getByRole("button", GOOGLE).click();
  await back;
  await waitForReady(page);
}

test("@journey a pending member continues with Google, and still enrols with the code and a passkey", async ({
  page,
  authenticator,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await server.google(true);
  await throughAccess(page, nadia, "/sign-in");
  await server.googleNext({ email: nadia, hd: "example.com" });
  await continueWithGoogle(page);
  // A first factor only: enrolment still asks for the enrolment code, then the passkey.
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
  expect(await viewerState(page)).toBe("pending");
  await enrol(page, enrolmentCode, "passkey");
  expect(await authenticator.list(authenticator.rpIdFor(ORIGIN))).toHaveLength(1);
  const events = (await server.audit()).map((e) => e.event);
  expect(events).toContain("staff.second_factor_required");
});

test("@journey a refused Google round trip says so on the card, and leaves no session", async ({
  page,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  await server.bootstrap(nadia);
  await server.google(true);
  const stranger = addresses.address("stranger");
  await throughAccess(page, stranger, "/sign-in");

  // Not on the staff list, though Access let them in.
  await server.googleNext({ email: stranger, hd: "example.com" });
  await continueWithGoogle(page);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in?error=account_refused`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin Admin" })).toBeVisible();
  await expect(
    inApp(page).getByText("That Google account can’t sign in to Fin Admin."),
  ).toBeVisible();
  expect(await viewerState(page)).toBe("signed_out");

  // A member's address, but not the one Access let in: refused the same way.
  await server.googleNext({ email: nadia, hd: "example.com" });
  await continueWithGoogle(page);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in?error=account_refused`);
  expect(await viewerState(page)).toBe("signed_out");

  // Cancelled at the provider.
  await server.googleNext("deny");
  await continueWithGoogle(page);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in?error=access_denied`);
  await expect(inApp(page).getByText("Google sign-in was cancelled.")).toBeVisible();
  const refused = (await server.audit()).filter((e) => e.event === "staff.sign_in_failed");
  expect(refused.map((e) => e.metadata)).toEqual([{ method: "google", reason: "access_mismatch" }]);
});

test("@journey with staff Google off the card offers no Google, and the realm has no Google path", async ({
  page,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");
  await expect(page.getByRole("button", { name: "Email me a code" })).toBeVisible();
  await expect(page.getByRole("button", GOOGLE)).toHaveCount(0);
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fin-App": "admin" },
      body: JSON.stringify({ provider: "google", callbackURL: "/sign-in" }),
    });
    return response.status;
  });
  expect(status).toBe(404);
});
