// The console's Saturday journeys end to end (spec 02 §19.3; EXECUTION §3.6): the built app on the
// harness's static host, its `/api/*` through the static host's tunnel to the console's API test
// server on Postgres 18, the emailed codes and links read from the email sink, and passkeys on the
// virtual authenticator. Nothing is stubbed: these are the journeys AC-SAT-02 to AC-SAT-08 name.
//
//   1. sign up, confirm the address, add a passkey (held, no Skip), set up an authenticator with a
//      step-up, then sign out and in with the passkey, and with the emailed code and the
//      authenticator at the factor step (Chromium, Firefox and WebKit: @security);
//   2. create an organisation, invite a teammate who signs up and accepts, make a role in the role
//      editor and give it to them with a step-up, change the role again in the editor, and read it
//      all in the audit log.
//
// The API test server is started by its own lane (packages/testing's configuration names its port,
// STATIC_APPS.console.apiPort). When it is not running, every journey here is skipped with that
// reason, never passed: the screen specs (screens.spec.ts) cover the boards meanwhile.
import {
  appOrigin,
  base32Decode,
  codeFrom,
  type EmailSinkReader,
  hotp,
  linksFrom,
  totpCounter,
} from "@fin/testing";
import { expect, gotoReady, installAuthenticator, test } from "@fin/testing/playwright";
import type { BrowserContext, Page } from "@playwright/test";

const ORIGIN = appOrigin("console");

let apiUp: boolean | null = null;

/** Whether the console's API test server answers behind the static host's tunnel. */
async function apiRunning(page: Page): Promise<boolean> {
  if (apiUp !== null) return apiUp;
  try {
    const answer = await page.request.get(`${ORIGIN}/api/health`, { timeout: 5000 });
    apiUp = answer.ok();
  } catch {
    apiUp = false;
  }
  return apiUp;
}

test.beforeEach(async ({ page }) => {
  test.skip(
    !(await apiRunning(page)),
    "the console's API test server is not running behind the static host (STATIC_APPS.console.apiPort)",
  );
});

async function codeFor(sink: EmailSinkReader, email: string, after: number): Promise<string> {
  return codeFrom(await sink.waitFor({ to: email, after }, { timeoutMs: 15_000 }));
}

async function enterCode(page: Page, label: string, code: string): Promise<void> {
  const input = page.getByRole("textbox", { name: label });
  await input.focus();
  await input.fill(code);
}

/** A fresh authenticator code for the shared secret, one step after `stepsAhead` used ones. */
function authenticatorCode(secret: Uint8Array, at: Date, stepsAhead: number): string {
  return hotp(secret, totpCounter(at.getTime()) + BigInt(stepsAhead));
}

interface Person {
  name: string;
  email: string;
}

/** Signs a new person up in this page and confirms the address; lands where the gate says. */
async function signUp(page: Page, sink: EmailSinkReader, person: Person): Promise<void> {
  const mark = await sink.mark();
  await gotoReady(page, "/sign-up");
  await page.getByRole("textbox", { name: "Full name" }).fill(person.name);
  await page.getByRole("textbox", { name: "Work email" }).fill(person.email);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify-email$/);
  await enterCode(page, "Confirmation code", await codeFor(sink, person.email, mark));
}

/** Protect your account, held with no Skip: adds a passkey on the virtual authenticator. */
async function addFirstPasskey(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/welcome\/secure/);
  await expect(page.getByRole("link", { name: "Skip for now" })).toHaveCount(0);
  await page.getByRole("button", { name: /Add a passkey/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome/ })).toBeVisible();
}

/** Proves the open StepUp dialog's intent with the passkey. */
async function confirmWithPasskey(page: Page, reason: string | RegExp): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(dialog).toContainText(reason);
  await dialog.getByRole("button", { name: "Use your passkey" }).click();
  await expect(dialog).toHaveCount(0);
}

/** Logs out from the account menu: a full load of /sign-in follows (the caller says what then). */
async function logOut(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: `Account menu, ${name}` }).click();
  await Promise.all([
    page.waitForURL(/\/sign-in$/, { waitUntil: "commit" }),
    page.getByRole("menuitem", { name: "Log out" }).click(),
  ]);
}

test.describe("signing up and signing in", () => {
  test("@journey @security sign up, a passkey and an authenticator, then sign in with each", async ({
    page,
    authenticator,
    emailSink,
    addresses,
    clock,
  }) => {
    const maya = { name: "Maya Rivera", email: addresses.fresh("maya") };
    await signUp(page, emailSink, maya);
    await addFirstPasskey(page);
    expect((await authenticator.list(authenticator.rpIdFor(ORIGIN))).length).toBe(1);

    // Account security: the authenticator, with the passkey as the step-up, and the codes once.
    await gotoReady(page, "/account/security");
    await page
      .getByRole("table", { name: "Your sign-in methods" })
      .getByRole("button", { name: "Set up" })
      .click();
    await confirmWithPasskey(page, "Use your second factor to set up an authenticator app.");
    const key = (await page.getByTestId("authenticator-key").textContent()) ?? "";
    const secret = base32Decode(key);
    await enterCode(
      page,
      "2. Enter the 6-digit code it shows",
      authenticatorCode(secret, clock.now(), 0),
    );
    const codes = page.getByRole("dialog", { name: "Save your backup codes" });
    await expect(codes.getByRole("listitem")).toHaveCount(10);
    await codes.getByRole("checkbox", { name: "I saved these codes somewhere safe" }).click();
    await codes.getByRole("button", { name: "Done" }).click();
    await expect(
      page.getByRole("table", { name: "Your sign-in methods" }).getByText("On", { exact: true }),
    ).toBeVisible();

    // Out, and in with the passkey: the sign-in page's autofill offers it, and choosing it (the
    // virtual authenticator does) signs in at once.
    await logOut(page, maya.name);
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();

    // Out, and in with the emailed code, then the authenticator at the factor step: this browser
    // no longer holds the passkey, as on another device.
    const rpId = authenticator.rpIdFor(ORIGIN);
    for (const credential of await authenticator.list(rpId)) {
      await authenticator.remove(credential.id);
    }
    await logOut(page, maya.name);
    await expect(page).toHaveURL(/\/sign-in$/);
    const mark = await emailSink.mark();
    await page.getByRole("textbox", { name: "Work email" }).fill(maya.email);
    await page.getByRole("button", { name: "Continue" }).click();
    await enterCode(
      page,
      "Or enter the 8-digit code from the email",
      await codeFor(emailSink, maya.email, mark),
    );
    await expect(page).toHaveURL(/\/sign-in\/two-factor$/);
    await enterCode(page, "Authenticator code", authenticatorCode(secret, clock.now(), 1));
    await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
  });
});

test.describe("organisations, the team and roles", () => {
  test("@journey create an organisation, invite and accept, a role through the editor, the audit log", async ({
    page,
    authenticator,
    emailSink,
    addresses,
    newContext,
  }) => {
    const maya = { name: "Maya Rivera", email: addresses.fresh("maya") };
    await signUp(page, emailSink, maya);
    await addFirstPasskey(page);
    expect(await authenticator.list(authenticator.rpIdFor(ORIGIN))).toHaveLength(1);

    // A second organisation, which becomes the current one.
    await gotoReady(page, "/settings/organisation?view=create");
    const create = page.getByRole("dialog", { name: "Create an organisation" });
    await create.getByRole("textbox", { name: "Organisation name" }).fill("Acme Remit Europe");
    await create.getByRole("button", { name: "Create organisation" }).click();
    await confirmWithPasskey(page, "Use your second factor to create an organisation.");
    await expect(page.getByRole("textbox", { name: "Organisation name" })).toHaveValue(
      "Acme Remit Europe",
    );

    // Invite a teammate as an Admin.
    const priya = { name: "Priya Shah", email: addresses.fresh("priya") };
    const mark = await emailSink.mark();
    await gotoReady(page, "/settings/team?view=invite");
    const invite = page.getByRole("dialog", { name: "Invite a teammate" });
    await invite.getByRole("textbox", { name: "Work email" }).fill(priya.email);
    await invite.getByRole("radio", { name: /^Admin/ }).check();
    await invite.getByRole("button", { name: "Send invite" }).click();
    await confirmWithPasskey(page, `Use your second factor to invite ${priya.email}.`);
    await expect(page.getByText(`Invitation sent to ${priya.email}`)).toBeVisible();

    // The teammate opens the link in their own browser, signs up and accepts.
    const message = await emailSink.waitFor(
      { to: priya.email, after: mark },
      { timeoutMs: 15_000 },
    );
    const link = linksFrom(message).find((href) => href.startsWith(`${ORIGIN}/invite#t=`));
    expect(
      link,
      "the invitation email links to /invite with the token in the fragment",
    ).toBeDefined();
    const other: BrowserContext = await newContext();
    await installAuthenticator(other);
    const theirs = await other.newPage();
    await gotoReady(theirs, link as string);
    await expect(theirs).toHaveURL(`${ORIGIN}/invite`);
    await expect(
      theirs.getByRole("heading", { level: 1, name: "Join Acme Remit Europe" }),
    ).toBeVisible();
    await theirs.getByRole("link", { name: "Create an account" }).click();
    const theirMark = await emailSink.mark();
    await theirs.getByRole("textbox", { name: "Full name" }).fill(priya.name);
    await theirs.getByRole("textbox", { name: "Work email" }).fill(priya.email);
    await theirs.getByRole("button", { name: "Create account" }).click();
    await enterCode(theirs, "Confirmation code", await codeFor(emailSink, priya.email, theirMark));
    await expect(theirs).toHaveURL(`${ORIGIN}/invite`);
    await theirs.getByRole("button", { name: "Accept invitation" }).click();
    await addFirstPasskey(theirs);

    // A role made in the editor, with its step-up.
    await gotoReady(page, "/settings/roles/new");
    await page.getByRole("textbox", { name: "Name" }).fill("Support");
    await page.getByRole("checkbox", { name: /^See the audit log/ }).click();
    await page.getByRole("checkbox", { name: /^See the team/ }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await confirmWithPasskey(page, "Use your second factor to create the role Support.");
    await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();

    // Given to the teammate on Team, with its step-up.
    await gotoReady(page, "/settings/team");
    await page.getByRole("button", { name: `Actions for ${priya.name}` }).click();
    await page.getByRole("menuitem", { name: "Change role" }).click();
    const change = page.getByRole("dialog", { name: `Change ${priya.name}’s role` });
    await change.getByRole("radio", { name: /^Support/ }).check();
    await change.getByRole("button", { name: "Save" }).click();
    await confirmWithPasskey(
      page,
      `Use your second factor to change ${priya.name}’s role to Support.`,
    );
    await expect(page.getByText(`${priya.name}’s role is now Support`)).toBeVisible();

    // Changed again in the editor: one more permission, saved with its step-up.
    await page.getByRole("link", { name: "Roles" }).click();
    await page.getByRole("link", { name: "Support", exact: true }).click();
    await page.getByRole("checkbox", { name: /^See keys/ }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await confirmWithPasskey(page, "Use your second factor to save the role Support.");
    await expect(
      page.getByText("Saved. Changes apply on each person’s next request."),
    ).toBeVisible();

    // The audit log, from the member's row menu, names what happened to them.
    await gotoReady(page, "/settings/team");
    await page.getByRole("button", { name: `Actions for ${priya.name}` }).click();
    await page.getByRole("menuitem", { name: "View in audit log" }).click();
    const log = page.getByRole("table", { name: "Audit log" });
    await expect(log).toContainText(`changed the role of ${priya.name} to Support`);
    await gotoReady(page, "/audit-log");
    await expect(log).toContainText("created the role Support");
    await expect(log).toContainText(`invited ${priya.email}`);
  });
});
