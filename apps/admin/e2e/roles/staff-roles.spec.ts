// Custom staff roles (spec 02 §10.7, §8.4, §15.3, §15.5; stretch 3; spec 06 §8.4's AdminRoles and
// AdminRoleEditor): the bootstrapped Admin opens Staff's Roles tab, sees the four prebuilt roles
// and no custom one, makes "Support desk" in the editor (needs ticked for her, Admin-only
// permissions locked, a name that reads as a prebuilt role refused) with "Confirm it's you", saves
// a change, gives the role to a new member, and deletes it with that member moved to Viewer; the
// member, holding the custom role, sees the roles read-only. Against the built app on the static
// host, behind the Access stand-in, with the admin API stand-in on the admin API port.
import { expect, test } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import {
  authenticatorCode,
  dialogsGone,
  emailedCodeSignIn,
  enrol,
  inApp,
  ORIGIN,
  server,
  stepUpDialog,
  throughAccess,
} from "../support/journey.ts";

test.beforeEach(async () => {
  await server.reset();
});

/** Answers "Confirm it's you" with the authenticator's next code, after checking its line. */
async function confirmWithCode(page: Page, key: string, line: string): Promise<void> {
  const confirm = stepUpDialog(page);
  await expect(confirm.getByText(line)).toBeVisible();
  await confirm
    .getByRole("textbox", { name: "Authenticator code" })
    .fill(await authenticatorCode(key));
  await expect(confirm).toBeHidden();
}

test("@journey an Admin makes, changes, gives and deletes a custom staff role, and a holder sees it read-only", async ({
  page,
  emailSink,
  addresses,
  newContext,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const mei = addresses.address("mei.tanaka");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/staff");
  await emailedCodeSignIn(page, emailSink, nadia);
  const key = (await enrol(page, enrolmentCode, "authenticator")) as string;

  // Staff has two tabs; Roles lists the four prebuilt roles and no custom one yet.
  const tabs = page.getByRole("navigation", { name: "Staff" });
  await expect(tabs.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Roles" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/staff/roles`);
  await expect(tabs.getByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");
  const prebuilt = page.getByRole("table", { name: "Prebuilt roles" });
  for (const label of ["Viewer", "Compliance", "Operator", "Admin"]) {
    await expect(prebuilt.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(inApp(page).getByText("No custom roles yet")).toBeVisible();

  // A new role: needs are ticked with what needs them; Admin-only permissions are locked.
  await page.getByRole("link", { name: "New role" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "New role" })).toBeVisible();
  const save = page.getByRole("button", { name: "Create role" });
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("checkbox", { name: "Handle requests for information" }).check();
  for (const need of ["See requests for information", "See customers"]) {
    await expect(page.getByRole("checkbox", { name: need })).toBeChecked();
  }
  await page.getByRole("checkbox", { name: "See staff" }).check();
  await expect(page.getByRole("checkbox", { name: "Reset second factors" })).toBeDisabled();
  await expect(inApp(page).getByText("Only the Admin role can have this.").first()).toBeVisible();
  const summary = page.getByRole("complementary", { name: "Summary" });
  await expect(summary.getByText("This role can do 4 things.")).toBeVisible();

  // A name that reads as a prebuilt role's is refused beside the field, before anything is sent.
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("Admins");
  await save.click();
  await expect(
    inApp(page).getByText("That reads like a prebuilt role’s name. Choose another."),
  ).toBeVisible();
  await name.fill("Support desk");
  await page.getByRole("textbox", { name: /Description/ }).fill("Answers questions from staff.");
  await save.click();
  await confirmWithCode(page, key, "Use your second factor to create the staff role Support desk.");
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/staff/roles/srl_[0-9a-z]{26}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Support desk" })).toBeVisible();
  const roleUrl = page.url();

  // A change: untick a permission, tick another, save with "Confirm it's you".
  await page.getByRole("checkbox", { name: "Handle requests for information" }).uncheck();
  await page.getByRole("checkbox", { name: "See organisations" }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await confirmWithCode(page, key, "Use your second factor to save the staff role Support desk.");
  await expect(
    inApp(page).getByText("Saved. Changes apply on each person’s next request."),
  ).toBeVisible();

  // Give it to Mei: the Staff page's picker lists the custom role beside the prebuilt ones.
  await page.getByRole("list", { name: "Settings" }).getByRole("link", { name: "Staff" }).click();
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(mei);
  await add.getByRole("radio", { name: "Support desk" }).check();
  await add.getByRole("button", { name: "Add staff" }).click();
  await confirmWithCode(page, key, `Use your second factor to add ${mei} to staff.`);
  const shown = page.getByRole("dialog", { name: "Staff added" });
  const meiCode = (
    (await shown.locator("[data-slot=copy-field] .font-mono").textContent()) ?? ""
  ).trim();
  await shown.getByRole("button", { name: "Done" }).click();
  await dialogsGone(page);
  await expect(
    page.getByRole("row").filter({ hasText: mei }).getByRole("cell", { name: "Support desk" }),
  ).toBeVisible();

  // Mei, holding the custom role (it reads staff): the roles and her own role, read-only.
  const meiContext = await newContext();
  await meiContext.credentials.install();
  const meiPage = await meiContext.newPage();
  await throughAccess(meiPage, mei, "/sign-in");
  await emailedCodeSignIn(meiPage, emailSink, mei);
  await enrol(meiPage, meiCode, "passkey");
  await meiPage.goto(`${ORIGIN}/staff/roles`);
  await expect(
    inApp(meiPage).getByText(
      "You can see the roles. Changing them needs Create and change staff roles.",
    ),
  ).toBeVisible();
  await expect(meiPage.getByRole("button", { name: "New role" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(meiPage.getByRole("button", { name: "More for Support desk" })).toHaveCount(0);
  await meiPage.goto(roleUrl);
  await expect(meiPage.getByRole("textbox", { name: "Name" })).toHaveAttribute("readonly", "");
  await expect(meiPage.getByRole("button", { name: "Save" })).toHaveCount(0);

  // Delete it while Mei holds it: she moves to the role Nadia picks.
  await page
    .getByRole("navigation", { name: "Staff" })
    .getByRole("link", { name: "Roles" })
    .click();
  const custom = page.getByRole("table", { name: "Custom roles" });
  await expect(custom.getByText("1 person")).toBeVisible();
  await custom.getByRole("button", { name: "More for Support desk" }).click();
  await page.getByRole("menuitem", { name: "Delete role" }).click();
  const remove = page.getByRole("dialog", { name: "Delete Support desk?" });
  await expect(
    remove.getByText("1 person has this role. Pick the role they move to."),
  ).toBeVisible();
  const confirmDelete = remove.getByRole("button", { name: "Delete role" });
  await expect(confirmDelete).toHaveAttribute("aria-disabled", "true");
  await expect(remove.getByRole("radio", { name: "Admin" })).toBeEnabled();
  await remove.getByRole("radio", { name: "Viewer" }).check();
  await confirmDelete.click();
  await confirmWithCode(page, key, "Use your second factor to delete the staff role Support desk.");
  await expect(inApp(page).getByText("Support desk was deleted")).toBeVisible();
  await expect(inApp(page).getByText("No custom roles yet")).toBeVisible();

  // Every change wrote its audit event, and Mei's move was a role change.
  const events = await server.audit();
  for (const event of [
    "staff.role_created",
    "staff.role_updated",
    "staff.role_changed",
    "staff.role_deleted",
  ]) {
    expect(
      events.map((e) => e.event),
      event,
    ).toContain(event);
  }
  expect(events.find((e) => e.event === "staff.role_changed")?.metadata).toMatchObject({
    toRole: "viewer",
    reason: "role_deleted",
  });
});

test("@journey a role key that names nothing is not found, and a prebuilt role is duplicated", async ({
  page,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/staff");
  await emailedCodeSignIn(page, emailSink, nadia);
  const key = (await enrol(page, enrolmentCode, "authenticator")) as string;

  await page.goto(`${ORIGIN}/staff/roles/srl_0000000000000000000000000z`);
  await expect(page.getByRole("heading", { name: "This role doesn’t exist" })).toBeVisible();
  await page.getByRole("link", { name: "Back to roles" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/staff/roles`);

  // A prebuilt role opens read-only, with Duplicate.
  await page
    .getByRole("table", { name: "Prebuilt roles" })
    .getByRole("link", { name: "Operator", exact: true })
    .click();
  await expect(inApp(page).getByText("Prebuilt roles can’t be changed.")).toBeVisible();
  await page.getByRole("link", { name: "Duplicate" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New role" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Operator copy");
  await page.getByRole("textbox", { name: "Name" }).fill("Duty operators");
  await page.getByRole("button", { name: "Create role" }).click();
  await confirmWithCode(
    page,
    key,
    "Use your second factor to create the staff role Duty operators.",
  );
  await expect(page.getByRole("heading", { level: 1, name: "Duty operators" })).toBeVisible();

  // A permission ticked in the copy can be unticked and saved.
  await page.getByRole("checkbox", { name: "Use the kill switches" }).uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await confirmWithCode(page, key, "Use your second factor to save the staff role Duty operators.");
  await expect(
    inApp(page).getByText("Saved. Changes apply on each person’s next request."),
  ).toBeVisible();
});
