// The staff factor reset (spec 02 §10.2, §10.4, §15.3, §15.4, [SA-14]; EXECUTION §3.1 stretch 4):
// an Admin resets a member who lost every factor. "Reset factors" on the member's row, the
// confirmation, "Confirm it's you" with the Admin's passkey, then the new enrolment code shown once.
// At that moment the member's session ends, their old passkey no longer signs in, and they and every
// Admin get the security notice (never the code); the member signs in by emailed code, enters the
// new enrolment code and adds a passkey again. Closing "Confirm it's you" resets nothing; a refusal
// after the proof is said in the dialog and reads the list again; the code stays on screen when the
// list then fails to load; a role without `staff.reset_factors` sees the control disabled with the
// reason and the server refuses it. Against the built app on the static host, behind the Access
// stand-in, with the API test server on the admin API port (FIN_E2E_ADMIN_API).

import type { EmailSinkReader } from "@fin/testing";
import { expect, test } from "@fin/testing/playwright";
import type { BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import {
  dialogsGone,
  ENDED_URL,
  emailedCodeSignIn,
  enrol,
  inApp,
  ORIGIN,
  server,
  stepUpDialog,
  throughAccess,
} from "../support/journey.ts";
import { RESET_TEMPLATE } from "./notice.ts";

const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const NOT_ALLOWED = "Your role doesn’t allow this. Ask someone who can change roles.";
const OWN = "You can’t reset your own second factors.";

test.beforeEach(async () => {
  await server.reset();
});

type NewContext = (options?: BrowserContextOptions) => Promise<BrowserContext>;

/** The bootstrapped first Admin, signed in with a passkey, on Staff. */
async function firstAdmin(page: Page, emailSink: EmailSinkReader, email: string): Promise<void> {
  const { enrolmentCode } = await server.bootstrap(email);
  await throughAccess(page, email, "/sign-in");
  await emailedCodeSignIn(page, emailSink, email);
  await enrol(page, enrolmentCode, "passkey");
}

/** The code in a "shown once" dialog, as drawn. */
async function shownCode(page: Page, title: string): Promise<string> {
  const dialog = page.getByRole("dialog", { name: title });
  const code = ((await dialog.locator("[data-slot=copy-field] .font-mono").textContent()) ?? "")
    .trim()
    .toUpperCase();
  expect(code).toMatch(CODE);
  return code;
}

/**
 * The Admin adds `email` with `role` and "Confirm it's you"; the member enrols a passkey in a
 * browser of their own. Returns the member's page, on Staff, and the code they used.
 */
async function activeMember(
  page: Page,
  newContext: NewContext,
  emailSink: EmailSinkReader,
  email: string,
  role: "Viewer" | "Operator",
): Promise<{ memberPage: Page; firstCode: string }> {
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(email);
  await add.getByRole("radio", { name: role }).check();
  await add.getByRole("button", { name: "Add staff" }).click();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  const firstCode = await shownCode(page, "Staff added");
  await page
    .getByRole("dialog", { name: "Staff added" })
    .getByRole("button", { name: "Done" })
    .click();
  await dialogsGone(page);

  const context = await newContext();
  await context.credentials.install();
  const memberPage = await context.newPage();
  await throughAccess(memberPage, email, "/sign-in");
  await emailedCodeSignIn(memberPage, emailSink, email);
  await enrol(memberPage, firstCode, "passkey");
  // The Admin's list now has them active.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: email }).getByText("Hasn’t signed in yet"),
  ).toHaveCount(0);
  return { memberPage, firstCode };
}

function resetButton(page: Page, email: string) {
  return page
    .getByRole("row")
    .filter({ hasText: email })
    .getByRole("button", { name: `Reset factors for ${email}` });
}

function confirmDialog(page: Page, email: string) {
  return page.getByRole("alertdialog", { name: `Reset ${email}’s second factors?` });
}

test("@journey an Admin resets a member's second factors: signed out at once, the old passkey refused, the new code once, and they enrol again", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
  newContext,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const mei = addresses.address("mei.tanaka");
  await firstAdmin(page, emailSink, nadia);
  const { memberPage, firstCode } = await activeMember(
    page,
    newContext,
    emailSink,
    mei,
    "Operator",
  );

  // Nadia's own row: her factors are not hers to reset here.
  const own = resetButton(page, nadia);
  await expect(own).toHaveAttribute("aria-disabled", "true");
  await own.hover();
  await expect(page.getByRole("tooltip", { name: OWN })).toBeVisible();
  await page.mouse.move(0, 0);

  // Mei's row: the confirmation says what happens, then "Confirm it's you" names her.
  await resetButton(page, mei).click();
  const confirm = confirmDialog(page, mei);
  await expect(
    confirm.getByText(
      "They’re signed out of Fin Admin at once, and their passkeys and authenticator app stop working. You get a new enrolment code to hand them.",
    ),
  ).toBeVisible();
  const mark = await emailSink.mark();
  await confirm.getByRole("button", { name: "Reset second factors" }).click();
  await expect(
    stepUpDialog(page).getByText(`Use your second factor to reset ${mei}’s second factors.`),
  ).toBeVisible();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();

  // The new code, once, to hand over in person.
  const shown = page.getByRole("dialog", { name: "Second factors reset" });
  await expect(
    shown.getByText(`Hand this code to ${mei} yourself. It works once, for 30 minutes.`),
  ).toBeVisible();
  await expect(
    shown.getByText("You won’t be able to see it again.", { exact: false }),
  ).toBeVisible();
  const resetCode = await shownCode(page, "Second factors reset");
  expect(resetCode).not.toBe(firstCode);
  await shown.getByRole("button", { name: "Done" }).click();
  await dialogsGone(page);
  await expect(
    page
      .getByRole("region", { name: "Notifications" })
      .getByText(`${mei} sets up a second factor again with the code you handed them.`),
  ).toBeVisible();
  // Pending again: no reset on her row, a new code instead; the code is nowhere on the page.
  const meiRow = page.getByRole("row").filter({ hasText: mei });
  await expect(meiRow.getByText("Hasn’t signed in yet")).toBeVisible();
  await expect(resetButton(page, mei)).toHaveCount(0);
  await expect(meiRow.getByRole("button", { name: `New enrolment code for ${mei}` })).toBeVisible();
  await expect(inApp(page).getByText(resetCode)).toHaveCount(0);

  // The audit trail: the step-up, the reset with what it removed, the code with its reason.
  const events = await server.audit();
  const reset = events.find((e) => e.event === "staff.factors_reset");
  expect(reset?.metadata).toEqual({ sessionsEnded: 1, factorsRemoved: 1 });
  expect(
    events.filter((e) => e.event === "staff.enrolment_code_issued").map((e) => e.metadata.reason),
  ).toEqual(["bootstrap", "added", "reset"]);
  expect(events.map((e) => e.event)).toContain("staff.step_up_passed");

  // The security notice, to Mei and to every Admin, with the template's own words and no code.
  const notices = (await emailSink.list({ template: RESET_TEMPLATE, after: mark })).messages;
  expect(notices.map((m) => m.to[0]).sort()).toEqual([mei, nadia].sort());
  const toMei = notices.find((m) => m.to.includes(mei));
  expect(toMei?.subject).toBe("Staff sign-in factors were reset in Fin Admin");
  expect(toMei?.text).toContain("You need a new enrolment code from an Admin to sign in again.");
  for (const message of notices) {
    for (const form of [resetCode, resetCode.replace(/-/g, "")]) {
      expect(message.text).not.toContain(form);
      expect(message.html ?? "").not.toContain(form);
    }
  }

  // Mei's browser: her session ended with the reset, so her next request signs her out.
  await memberPage.getByRole("button", { name: `Account menu, ${mei}` }).click();
  await memberPage.getByRole("menuitem", { name: "Your sign-in" }).click();
  await expect(memberPage).toHaveURL(ENDED_URL);
  await expect(inApp(memberPage).getByText("You were signed out. Sign in again.")).toBeVisible();

  // Her old passkey, still in her browser, no longer signs her in.
  await memberPage.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    inApp(memberPage).getByText("Couldn’t sign you in with that passkey.", { exact: false }),
  ).toBeVisible();

  // The emailed code leads to enrolment, not the factor step; the old code is refused, the new
  // one opens it, and a new passkey makes her active again.
  await memberPage.goto(`${ORIGIN}/sign-in`);
  await emailedCodeSignIn(memberPage, emailSink, mei);
  await memberPage.getByRole("textbox", { name: "Enrolment code" }).fill(firstCode);
  await memberPage.getByRole("button", { name: "Continue" }).click();
  await expect(
    inApp(memberPage).getByText("That code didn’t work. Check it and try again."),
  ).toBeVisible();
  await memberPage.getByRole("textbox", { name: "Enrolment code" }).fill("");
  await enrol(memberPage, resetCode, "passkey");

  // As an Operator she sees the reset disabled with the reason, and the server refuses it.
  const nadiaFromMei = resetButton(memberPage, nadia);
  await expect(nadiaFromMei).toHaveAttribute("aria-disabled", "true");
  await nadiaFromMei.hover();
  await expect(memberPage.getByRole("tooltip", { name: NOT_ALLOWED })).toBeVisible();
  const nadiaId = (await server.audit()).find((e) => e.event === "staff.bootstrapped")?.target;
  const refused = await memberPage.evaluate(async (id) => {
    const response = await fetch(`/api/staff/${id}/reset-factors`, {
      method: "POST",
      headers: { Accept: "application/json", "X-Fin-App": "admin" },
    });
    return { status: response.status, code: ((await response.json()) as { code: string }).code };
  }, nadiaId);
  expect(refused).toEqual({ status: 403, code: "forbidden" });
  expect((await server.audit()).filter((e) => e.event === "staff.factors_reset")).toHaveLength(1);

  // Nadia's list says Mei is back.
  await page.reload();
  await expect(meiRow.getByText("Hasn’t signed in yet")).toHaveCount(0);
  await expect(resetButton(page, mei)).toBeVisible();
});

test("@journey closing Confirm it's you resets nothing; a refusal after the proof is said and the list read again", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
  newContext,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const ines = addresses.address("ines.moreau");
  await firstAdmin(page, emailSink, nadia);
  const { memberPage } = await activeMember(page, newContext, emailSink, ines, "Viewer");

  // Closed at "Confirm it's you": the confirmation stays, says nothing, and nothing changed.
  await resetButton(page, ines).click();
  const confirm = confirmDialog(page, ines);
  await confirm.getByRole("button", { name: "Reset second factors" }).click();
  await stepUpDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(stepUpDialog(page)).toBeHidden();
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("alert")).toHaveCount(0);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await dialogsGone(page);
  expect((await server.audit()).map((e) => e.event)).not.toContain("staff.factors_reset");
  await memberPage.reload();
  await expect(memberPage.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();

  // Someone else removed her meanwhile: the server refuses after the proof; the dialog says so and
  // the page reads the list again.
  await page.route("**/api/staff/*/reset-factors", async (route) => {
    if (route.request().headers()["fin-step-up-intent"] === undefined) return route.fallback();
    await route.fulfill({
      status: 404,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      body: JSON.stringify({
        type: "https://docs.localhost/errors/not_found",
        title: "not found",
        status: 404,
        code: "not_found",
        request_id: "req_e2e",
      }),
    });
  });
  await resetButton(page, ines).click();
  await confirmDialog(page, ines).getByRole("button", { name: "Reset second factors" }).click();
  const reread = page.waitForRequest(
    (request) => request.method() === "GET" && new URL(request.url()).pathname === "/api/staff",
  );
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  await expect(stepUpDialog(page)).toBeHidden();
  await expect(
    confirmDialog(page, ines).getByText("They’re no longer on staff. The list is up to date now."),
  ).toBeVisible();
  await reread;
  await confirmDialog(page, ines).getByRole("button", { name: "Cancel" }).click();
  await dialogsGone(page);
  await page.unroute("**/api/staff/*/reset-factors");
  expect((await server.audit()).map((e) => e.event)).not.toContain("staff.factors_reset");

  // The real reset, then the list cannot load: the code stays on screen until Done.
  await page.route("**/api/staff?*", (route) =>
    route.fulfill({
      status: 503,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      body: JSON.stringify({
        type: "https://docs.localhost/errors/unavailable",
        title: "unavailable",
        status: 503,
        code: "unavailable",
        request_id: "req_e2e_list",
      }),
    }),
  );
  await resetButton(page, ines).click();
  await confirmDialog(page, ines).getByRole("button", { name: "Reset second factors" }).click();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  const code = await shownCode(page, "Second factors reset");
  await expect(inApp(page).getByText("Couldn’t load staff")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Second factors reset" })).toBeVisible();
  await page
    .getByRole("dialog", { name: "Second factors reset" })
    .getByRole("button", { name: "Done" })
    .click();
  await dialogsGone(page);
  await expect(inApp(page).getByText(code)).toHaveCount(0);
  expect((await server.audit()).filter((e) => e.event === "staff.factors_reset")).toHaveLength(1);
});
