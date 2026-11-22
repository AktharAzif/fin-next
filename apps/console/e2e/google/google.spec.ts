// "Continue with Google" in a real browser (spec 02 §5.8, §15.2; spec 06 §8.2's stretch-5 states of
// the SignIn and SignUp boards; EXECUTION S-02's Google round trip against a mock provider).
//
//   - The boards: the built app on the harness's static host under the production page policy,
//     `/api/*` answered by the scripted stand-in (support/api-double.ts): the button only when the
//     console says Google is on, what it sends and its busy state, every refusal the round trip
//     comes back with, and the first organisation made on the way back.
//   - The journey (`@google`): the console's real API half and the fixture OpenID provider
//     (google/run.ts starts both): a new person continues with Google, is held at Protect your
//     account (owning their first organisation is privileged, [SA-05]) where Google's verified
//     address lets them add the first factor (§6.3), and a later Google sign-in stops at the factor
//     step; a cancelled try says so. Without those servers the journey is skipped with the reason.
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import { ApiDouble, noContent, ok, problem, viewer } from "../support/api-double.ts";
import { OAUTH_FIXTURE_ORIGIN, provider } from "./support.ts";

const OPTIONS = {
  challenge: "Y2hhbGxlbmdlLWZvci1lMmU",
  rpId: "console.localhost",
  allowCredentials: [],
  userVerification: "required",
  timeout: 60000,
};

function signedOut(google: boolean): ApiDouble {
  return new ApiDouble()
    .on("GET /api/viewer", problem(401, "unauthenticated"))
    .on("GET /api/auth/passkey/generate-authenticate-options", ok(OPTIONS))
    .on("GET /api/invitation", noContent())
    .on("GET /api/sign-in/methods", ok({ google }));
}

const google = (page: Page) => page.getByRole("button", { name: "Continue with Google" });

test.describe("the Google button on the boards", () => {
  test("@journey Google off: no button on sign-in or sign-up", async ({ page }) => {
    const api = signedOut(false);
    await api.install(page);
    await gotoReady(page, "/sign-in");
    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    await expect.poll(() => api.calls("GET /api/sign-in/methods").length).toBeGreaterThan(0);
    await expect(google(page)).toHaveCount(0);
    await gotoReady(page, "/sign-up");
    await expect(
      page.getByRole("heading", { level: 1, name: "Create your Fin account" }),
    ).toBeVisible();
    await expect(google(page)).toHaveCount(0);
  });

  test("@journey @security Continue with Google: busy, then sent where the server says, with the page kept", async ({
    page,
  }) => {
    const api = signedOut(true).on("POST /api/auth/sign-in/social", (request) => ({
      status: 200,
      // The provider's address, stood in by the console's own sign-in page coming back cancelled.
      body: {
        url: `${String(request.headers.origin)}/sign-in?error=access_denied`,
        redirect: false,
      },
      delayMs: 600,
    }));
    await api.install(page);
    await gotoReady(page, "/sign-in?next=%2Fsettings%2Fteam");
    const button = google(page);
    await expect(button).toBeVisible();
    await button.click();
    // googleBusy: the button says it is working while the round trip starts.
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(/\/sign-in\?error=access_denied$/);
    await expect(page.getByText("Google sign-in was cancelled.").first()).toBeVisible();
    const sent = api.calls("POST /api/auth/sign-in/social");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["x-fin-app"]).toBe("console");
    expect(sent[0]?.body).toEqual({
      provider: "google",
      callbackURL: "/sign-in?via=google&next=%2Fsettings%2Fteam",
      errorCallbackURL: "/sign-in?next=%2Fsettings%2Fteam",
      disableRedirect: true,
    });
  });

  test("@journey the sign-up board offers Google too, busy while it starts, and comes back to itself", async ({
    page,
  }) => {
    const api = signedOut(true).on("POST /api/auth/sign-in/social", (request) => ({
      status: 200,
      body: { url: `${String(request.headers.origin)}/sign-up?error=account_not_linked` },
      delayMs: 600,
    }));
    await api.install(page);
    await gotoReady(page, "/sign-up");
    await google(page).click();
    await expect(google(page)).toHaveAttribute("aria-busy", "true");
    await expect(page).toHaveURL(/\/sign-up\?error=account_not_linked$/);
    await expect(page.getByText("This email already has a Fin account.").first()).toBeVisible();
    expect(api.calls("POST /api/auth/sign-in/social")[0]?.body).toMatchObject({
      callbackURL: "/sign-in?via=google",
      errorCallbackURL: "/sign-up",
    });
  });

  for (const [error, title] of [
    ["account_not_linked", "This email already has a Fin account."],
    ["access_denied", "Google sign-in was cancelled."],
    ["email_unverified", "Google hasn’t confirmed that account’s email address."],
    ["unable_to_create_user", "We couldn’t create your account with Google."],
    ["google_failed", "Google sign-in isn’t working right now."],
    ["email_not_found", "Google didn’t share an email address for that account."],
    ["state_mismatch", "Google sign-in didn’t finish."],
  ] as const) {
    test(`@journey a round trip refused with ${error} says so on the card`, async ({ page }) => {
      await signedOut(true).install(page);
      await gotoReady(page, `/sign-in?error=${error}`);
      await expect(page.getByText(title).first()).toBeVisible();
      // The other ways in stay offered.
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
      await expect(google(page)).toBeVisible();
    });
  }

  test("@journey back from Google with no organisation yet: the first one is made, then home", async ({
    page,
  }) => {
    let made = false;
    const api = signedOut(true)
      .on("GET /api/viewer", () =>
        ok(made ? viewer() : viewer({ memberships: [], currentOrgId: null, permissions: [] })),
      )
      .on("POST /api/orgs/first", () => {
        made = true;
        return { status: 201, body: { orgId: "org_acme" } };
      })
      .on("GET /api/org", ok({ orgId: "org_acme", name: "Acme Remit", roleKey: "super_admin" }))
      .on("GET /api/orgs", ok({ items: [], total: 0 }));
    await api.install(page);
    await gotoReady(page, "/sign-in?via=google");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
    expect(api.calls("POST /api/orgs/first")).toHaveLength(1);
  });
});

// The journey against the real API half and the fixture provider (google/run.ts).
test.describe("Google sign-in, end to end", () => {
  // The provider's pages are the one other origin this journey's browser reaches.
  test.use({ allowedOrigins: [OAUTH_FIXTURE_ORIGIN] });

  test.beforeEach(async ({ page }) => {
    let methods: { google?: unknown } | null = null;
    try {
      const answer = await page.request.get("/api/sign-in/methods", { timeout: 5000 });
      methods = answer.ok() ? ((await answer.json()) as { google?: unknown }) : null;
    } catch {
      methods = null;
    }
    test.skip(
      methods?.google !== true || !(await provider.running()),
      "the console's API test server with Google on and the fixture provider are not running (apps/console/e2e/google/run.ts starts them)",
    );
  });

  test("@journey @google @security a new person continues with Google, adds a passkey, and later stops at the factor step", async ({
    page,
    authenticator,
    addresses,
  }) => {
    const email = addresses.fresh("google");
    const sub = `1${Date.now()}`;

    // A cancelled try comes back to the card that started it.
    await provider.next("deny");
    await gotoReady(page, "/sign-in");
    await google(page).click();
    await expect(page).toHaveURL(/\/sign-in\?error=access_denied$/);
    await expect(page.getByText("Google sign-in was cancelled.").first()).toBeVisible();

    // A new person: their account and first organisation, then Protect your account, held with no
    // Skip; Google verified their own address, so the first factor may be added now.
    await provider.next({ sub, email, name: "Maya Rivera" });
    await google(page).click();
    await expect(page).toHaveURL(/\/welcome\/secure/);
    await expect(page.getByRole("link", { name: "Skip for now" })).toHaveCount(0);
    await page.getByRole("button", { name: /Add a passkey/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: /^Welcome/ })).toBeVisible();
    expect(
      await authenticator.list(authenticator.rpIdFor(new URL(page.url()).origin)),
    ).toHaveLength(1);

    // Out, and in with Google again: an aal1 session, so the factor step asks for the factor. The
    // passkey leaves this browser first, as on another device, so the page's autofill offers none.
    const rpId = authenticator.rpIdFor(new URL(page.url()).origin);
    for (const credential of await authenticator.list(rpId)) {
      await authenticator.remove(credential.id);
    }
    await page.getByRole("button", { name: /^Account menu, / }).click();
    await Promise.all([
      page.waitForURL(/\/sign-in$/, { waitUntil: "commit" }),
      page.getByRole("menuitem", { name: "Log out" }).click(),
    ]);
    await provider.next({ sub, email, name: "Maya Rivera" });
    await google(page).click();
    await expect(page).toHaveURL(/\/sign-in\/two-factor/);
  });
});
