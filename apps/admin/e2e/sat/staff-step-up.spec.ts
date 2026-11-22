// T-SAT-67 (spec 02 §19.3): "Confirm it's you" on the Staff page's intent actions. Closing it
// changes nothing; a new enrolment code for a pending member replaces the old one; removing a
// member takes the step-up and says what comes next (the Access list); a refusal the server makes
// after the proof (the last Admin, reached here by a stale page) is said in the dialog. Every
// AdminStepUp state: the authenticator's short code and its check, five wrong codes ending the
// session (spec 02 §7.7, no stub: the API test server ends it), the passkey's prompt open and
// closed, and a browser without passkeys. The code shown once after Add staff stays on screen when
// the list then fails to load.

import type { EmailSinkReader } from "@fin/testing";
import { expect, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import {
  authenticatorCode,
  dialogsGone,
  ENDED_URL,
  emailedCodeSignIn,
  endNextPasskeyPrompt,
  enrol,
  hold,
  inApp,
  ORIGIN,
  server,
  stepUpDialog,
  throughAccess,
  tryCode,
  viewerState,
  withoutPasskeys,
  wrongCodes,
} from "../support/journey.ts";

test.beforeEach(async () => {
  await server.reset();
});

async function signedInAdmin(page: Page, emailSink: EmailSinkReader, email: string) {
  const { enrolmentCode } = await server.bootstrap(email);
  await throughAccess(page, email, "/sign-in");
  await emailedCodeSignIn(page, emailSink, email);
  await enrol(page, enrolmentCode, "passkey");
}

test("@journey closing Confirm it's you adds nobody", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  await signedInAdmin(page, emailSink, addresses.address("nadia.brooks"));
  const mei = addresses.address("mei.tanaka");
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(mei);
  await add.getByRole("button", { name: "Add staff" }).click();
  await stepUpDialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(stepUpDialog(page)).toBeHidden();
  await expect(add).toBeVisible();
  // A refusal is drawn as the kit's InlineAlert, which has no alert role of its own: none is drawn.
  await expect(add.locator("[data-slot=inline-alert]")).toHaveCount(0);
  await add.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("row").filter({ hasText: mei })).toHaveCount(0);
  expect((await server.audit()).map((e) => e.event)).not.toContain("staff.member_added");
});

test("@journey a new enrolment code, then removing the member, each with the passkey", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  await signedInAdmin(page, emailSink, addresses.address("nadia.brooks"));
  const mei = addresses.address("mei.tanaka");
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(mei);
  await add.getByRole("button", { name: "Add staff" }).click();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  const first = page.getByRole("dialog", { name: "Staff added" });
  const firstCode = (
    (await first.locator("[data-slot=copy-field] .font-mono").textContent()) ?? ""
  ).trim();
  await first.getByRole("button", { name: "Done" }).click();
  await dialogsGone(page);

  const row = page.getByRole("row").filter({ hasText: mei });
  await row.getByRole("button", { name: `New enrolment code for ${mei}` }).click();
  const confirmNew = page.getByRole("alertdialog", {
    name: `Make a new enrolment code for ${mei}?`,
  });
  await confirmNew.getByRole("button", { name: "Make a new code" }).click();
  await expect(
    stepUpDialog(page).getByText(`Use your second factor to make a new enrolment code for ${mei}.`),
  ).toBeVisible();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  const second = page.getByRole("dialog", { name: "New enrolment code" });
  const secondCode = (
    (await second.locator("[data-slot=copy-field] .font-mono").textContent()) ?? ""
  ).trim();
  expect(secondCode).not.toBe(firstCode);
  await second.getByRole("button", { name: "Done" }).click();
  await dialogsGone(page);

  await row.getByRole("button", { name: `Remove ${mei}` }).click();
  const remove = page.getByRole("alertdialog", { name: `Remove ${mei} from staff?` });
  await expect(
    remove.getByText("Take their address off the Access list next.", { exact: false }),
  ).toBeVisible();
  await remove.getByRole("button", { name: "Remove from staff" }).click();
  await expect(
    stepUpDialog(page).getByText(`Use your second factor to remove ${mei} from staff.`),
  ).toBeVisible();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  await expect(inApp(page).getByText("Removed from staff")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: mei })).toHaveCount(0);
  const events = (await server.audit()).map((e) => e.event);
  expect(events).toContain("staff.member_removed");
  expect(events.filter((e) => e === "staff.enrolment_code_issued")).toHaveLength(3);
});

test("@journey the last Admin refused by the server after the proof is said in the dialog", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  await signedInAdmin(page, emailSink, addresses.address("nadia.brooks"));
  const ines = addresses.address("ines.moreau");
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(ines);
  await add.getByRole("radio", { name: "Admin" }).check();
  await add.getByRole("button", { name: "Add staff" }).click();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  await page
    .getByRole("dialog", { name: "Staff added" })
    .getByRole("button", { name: "Done" })
    .click();
  await dialogsGone(page);

  // The server answers as if Ines were the last active Admin (a change elsewhere), after the proof.
  await page.route("**/api/staff/*/remove", async (route) => {
    if (route.request().headers()["fin-step-up-intent"] === undefined) return route.fallback();
    await route.fulfill({
      status: 409,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      body: JSON.stringify({
        type: "https://docs.localhost/errors/last_top_role",
        title: "last top role",
        status: 409,
        code: "last_top_role",
        request_id: "req_e2e",
      }),
    });
  });
  await page
    .getByRole("row")
    .filter({ hasText: ines })
    .getByRole("button", { name: `Remove ${ines}` })
    .click();
  const remove = page.getByRole("alertdialog", { name: `Remove ${ines} from staff?` });
  await remove.getByRole("button", { name: "Remove from staff" }).click();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  await expect(stepUpDialog(page)).toBeHidden();
  await expect(
    remove.getByText("Fin Admin needs at least one Admin. Make someone else an Admin first."),
  ).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: ines })).toHaveCount(1);
});

test("@journey five wrong codes at Confirm it's you end the session, and only Sign in again is left", async ({
  page,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const mei = addresses.address("mei.tanaka");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");
  await emailedCodeSignIn(page, emailSink, nadia);
  const key = (await enrol(page, enrolmentCode, "authenticator")) as string;

  // Add staff with the authenticator alone: a short code, then the right one while it is checked.
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(mei);
  await add.getByRole("button", { name: "Add staff" }).click();
  const confirm = stepUpDialog(page);
  const box = confirm.getByRole("textbox", { name: "Authenticator code" });
  const confirmButton = confirm.getByRole("button", { name: "Confirm" });
  await expect(box).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Use my passkey" })).toHaveCount(0);
  await box.fill("123");
  await confirmButton.click();
  await expect(
    confirm.getByText("Enter the 6-digit code from your authenticator app."),
  ).toBeVisible();
  const checking = await hold(page, "**/api/auth/two-factor/verify-totp");
  await box.fill(await authenticatorCode(key));
  await expect(confirmButton).toHaveAttribute("aria-busy", "true");
  checking.release();
  await page
    .getByRole("dialog", { name: "Staff added" })
    .getByRole("button", { name: "Done" })
    .click();
  await dialogsGone(page);

  // Change Mei's role: five wrong codes, and the API test server ends the session on the fifth.
  await page
    .getByRole("row")
    .filter({ hasText: mei })
    .getByRole("button", { name: `Change role of ${mei}` })
    .click();
  const change = page.getByRole("dialog", { name: "Change role" });
  await change.getByRole("radio", { name: "Operator" }).check();
  await change.getByRole("button", { name: "Change role" }).click();
  await expect(box).toBeVisible();
  const codes = await wrongCodes(key, 5);
  for (const [index, code] of codes.entries()) {
    const answer = await tryCode(page, box, confirmButton, code);
    if (index < 4) expect(answer).toMatchObject({ status: 401, code: "INVALID_CODE" });
    else expect(answer).toEqual({ status: 401, code: "unauthenticated", reason: "too_many_tries" });
  }
  await expect(confirm.getByText("You were signed out after too many wrong tries.")).toBeVisible();
  const again = confirm.getByRole("button", { name: "Sign in again" });
  await expect(again).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(box).toBeDisabled();

  // The session is gone on the server: the next viewer is signed out, the lock is audited, and
  // the role did not change.
  expect(await viewerState(page)).toBe("signed_out");
  const events = (await server.audit()).map((e) => e.event);
  expect(events).toContain("staff.step_up_locked");
  expect(events).not.toContain("staff.role_changed");

  await again.click();
  await expect(page).toHaveURL(ENDED_URL);
  await expect(inApp(page).getByText("You were signed out. Sign in again.")).toBeVisible();
});

test("@journey a limit at Confirm it's you says to wait, and signs nobody out", async ({
  page,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");
  await emailedCodeSignIn(page, emailSink, nadia);
  const key = (await enrol(page, enrolmentCode, "authenticator")) as string;
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(addresses.address("mei.tanaka"));
  await add.getByRole("button", { name: "Add staff" }).click();
  const confirm = stepUpDialog(page);
  const box = confirm.getByRole("textbox", { name: "Authenticator code" });

  // The realm's limit (a 429; the session is not ended): wait and try later, nothing more.
  await page.route("**/api/auth/two-factor/verify-totp", (route) =>
    route.fulfill({
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ code: "ACCOUNT_TEMPORARILY_LOCKED", message: "locked" }),
    }),
  );
  await box.fill(await authenticatorCode(key));
  await expect(confirm.getByText("Too many wrong tries.", { exact: true })).toBeVisible();
  await expect(confirm.getByText("Try again later.", { exact: true })).toBeVisible();
  await expect(confirm.getByText("signed out", { exact: false })).toHaveCount(0);
  await expect(confirm.getByRole("button", { name: "Sign in again" })).toHaveCount(0);
  await expect(box).toBeDisabled();
  expect(await viewerState(page)).toBe("ok");
  await page.unroute("**/api/auth/two-factor/verify-totp");

  // Cancel leaves the person where they were, still signed in.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  expect((await server.audit()).map((e) => e.event)).not.toContain("staff.member_added");
});

test("@journey the passkey at Confirm it's you: closed, waiting, and a browser without passkeys", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  await signedInAdmin(page, emailSink, addresses.address("nadia.brooks"));
  const mei = addresses.address("mei.tanaka");
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(mei);
  await add.getByRole("button", { name: "Add staff" }).click();
  const confirm = stepUpDialog(page);
  const passkey = confirm.getByRole("button", { name: "Use my passkey" });
  await expect(passkey).toBeVisible();
  await expect(confirm.getByRole("textbox", { name: "Authenticator code" })).toHaveCount(0);

  // The person closes the prompt: the dialog says so and stays.
  await endNextPasskeyPrompt(page, "get");
  await passkey.click();
  await expect(confirm.getByText("The passkey prompt was closed.")).toBeVisible();
  expect((await server.audit()).map((e) => e.event)).not.toContain("staff.member_added");

  // While the prompt is open the button waits; the passkey then proves the intent.
  const prompt = await hold(page, "**/api/auth/passkey/generate-authenticate-options");
  await passkey.click();
  await expect(passkey).toHaveAttribute("aria-busy", "true");
  prompt.release();
  await page
    .getByRole("dialog", { name: "Staff added" })
    .getByRole("button", { name: "Done" })
    .click();
  await dialogsGone(page);

  // In a browser that cannot use passkeys, the dialog says so and offers no way it cannot keep.
  await withoutPasskeys(page);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  await page.getByRole("button", { name: "Add staff" }).click();
  await add.getByRole("textbox", { name: "Work email" }).fill(addresses.address("ines.moreau"));
  await add.getByRole("button", { name: "Add staff" }).click();
  await expect(confirm.getByText("This browser can’t use passkeys.")).toBeVisible();
  await expect(
    confirm.getByText(
      "Open Fin Admin in a browser that can, or ask an Admin to reset your second factors.",
    ),
  ).toBeVisible();
  await expect(passkey).toHaveCount(0);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
});

test("@journey the code shown once stays on screen when the list then fails to load", async ({
  page,
  authenticator: _authenticator,
  emailSink,
  addresses,
}) => {
  await signedInAdmin(page, emailSink, addresses.address("nadia.brooks"));
  const mei = addresses.address("mei.tanaka");
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(mei);
  await add.getByRole("button", { name: "Add staff" }).click();
  const passkey = stepUpDialog(page).getByRole("button", { name: "Use my passkey" });
  await expect(passkey).toBeVisible();

  // The member is added; the list's reload after it fails.
  await page.route("**/api/staff?*", (route) =>
    route.fulfill({
      status: 503,
      headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      body: JSON.stringify({
        type: "https://docs.localhost/errors/unavailable",
        title: "unavailable",
        status: 503,
        code: "unavailable",
        request_id: "req_e2e",
      }),
    }),
  );
  await passkey.click();
  const shown = page.getByRole("dialog", { name: "Staff added" });
  await expect(
    shown.getByText(`Hand this code to ${mei} yourself. It works once, for 30 minutes.`),
  ).toBeVisible();
  const code = (
    (await shown.locator("[data-slot=copy-field] .font-mono").textContent()) ?? ""
  ).trim();
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  expect((await server.audit()).map((e) => e.event)).toContain("staff.member_added");
  await shown.getByRole("button", { name: "Done" }).click();
  await dialogsGone(page);

  // The list says it couldn't load, and claims nothing about the change that went through.
  await expect(inApp(page).getByText("Couldn’t load staff")).toBeVisible();
  await expect(inApp(page).getByText("Nothing was changed", { exact: false })).toHaveCount(0);
  await page.unroute("**/api/staff?*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("row").filter({ hasText: mei })).toHaveCount(1);
});
