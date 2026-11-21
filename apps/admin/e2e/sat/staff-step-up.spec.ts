// T-SAT-67 (spec 02 §19.3): "Confirm it's you" on the Staff page's intent actions. Closing it
// changes nothing; a new enrolment code for a pending member replaces the old one; removing a
// member takes the step-up and says what comes next (the Access list); a refusal the server makes
// after the proof (the last Admin, reached here by a stale page) is said in the dialog.

import type { EmailSinkReader } from "@fin/testing";
import { expect, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import {
  dialogsGone,
  emailedCodeSignIn,
  enrol,
  server,
  stepUpDialog,
  throughAccess,
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
  await expect(add.getByRole("alert")).toHaveCount(0);
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
  await expect(page.getByText("Removed from staff")).toBeVisible();
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
