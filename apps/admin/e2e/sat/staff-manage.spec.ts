// T-SAT-66 (spec 02 §19.3; T-SAT-65's forced enrolment and its once-only code are in
// staff-enrolment.spec.ts): the bootstrapped Admin signs in with the emailed code, enters
// the enrolment code, enrols an authenticator and then a passkey, adds a member of staff with
// "Confirm it's you" and sees the enrolment code once, changes their role, and cannot remove the
// last Admin; the new member enrols with both codes, and as a Viewer sees the controls disabled
// while the server refuses them. Against the built app on the static host, behind the Access
// stand-in, with the API test server on the admin API port (FIN_E2E_ADMIN_API).
import { expect, test } from "@fin/testing/playwright";
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

test("@journey the first Admin enrols, adds staff with a step-up, changes the role, and stays the last Admin", async ({
  page,
  authenticator,
  emailSink,
  addresses,
  newContext,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const mei = addresses.address("mei.tanaka");
  const { enrolmentCode } = await server.bootstrap(nadia);

  // Signed out: Access lets Nadia in; Fin Admin asks her to sign in, with her Access address.
  await throughAccess(page, nadia, "/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await emailedCodeSignIn(page, emailSink, nadia);

  // Pending: the enrolment code comes first, and a wrong one is refused.
  await page.getByRole("textbox", { name: "Enrolment code" }).fill("AAAA-AAAA-AAAA-AAAA");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    inApp(page).getByText("That code didn’t work. Check it and try again."),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Enrolment code" }).fill("");
  const key = await enrol(page, enrolmentCode, "authenticator");
  expect(key).not.toBeNull();

  // Staff: Nadia alone, the Admin, with the four prebuilt roles.
  const nadiaRow = page.getByRole("row").filter({ hasText: nadia });
  await expect(nadiaRow.getByText("You", { exact: true })).toBeVisible();
  await expect(nadiaRow.getByRole("cell", { name: "Admin", exact: true })).toBeVisible();
  const roles = page
    .getByRole("region", { name: "Roles" })
    .or(page.locator("section[aria-labelledby=staff-roles]"));
  for (const label of ["Viewer", "Compliance", "Operator", "Admin"]) {
    await expect(roles.getByText(label, { exact: true })).toBeVisible();
  }

  // The last Admin: her own row cannot be removed or changed, and the server refuses it too.
  const removeSelf = nadiaRow.getByRole("button", { name: `Remove ${nadia}` });
  await expect(removeSelf).toHaveAttribute("aria-disabled", "true");
  await expect(nadiaRow.getByRole("button", { name: `Change role of ${nadia}` })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await removeSelf.hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Fin Admin needs at least one Admin. Make someone else an Admin first.",
    }),
  ).toBeVisible();
  const staffId = (await server.audit()).find((e) => e.event === "staff.bootstrapped")?.target;
  const refused = await page.evaluate(async (id) => {
    const response = await fetch(`/api/staff/${id}/remove`, {
      method: "POST",
      headers: { Accept: "application/json", "X-Fin-App": "admin" },
    });
    return { status: response.status, code: ((await response.json()) as { code: string }).code };
  }, staffId);
  expect([403, 409]).toContain(refused.status);
  expect(["giving_refused", "last_top_role"]).toContain(refused.code);

  // Your sign-in: add a passkey, confirmed with the authenticator's code.
  await page.getByRole("button", { name: `Account menu, ${nadia}` }).click();
  await page.getByRole("menuitem", { name: "Your sign-in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const confirm = stepUpDialog(page);
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText("Use your second factor to add a passkey.")).toBeVisible();
  await confirm
    .getByRole("textbox", { name: "Authenticator code" })
    .fill(await authenticatorCode(key as string));
  await expect(confirm).toBeHidden();
  await expect(inApp(page).getByText("Passkey added")).toBeVisible();
  expect(await authenticator.list(authenticator.rpIdFor(ORIGIN))).toHaveLength(1);
  await expect(page.getByRole("table", { name: "Second factors" }).getByRole("row")).toHaveCount(3);

  // Add staff: the address and the role, "Confirm it's you" with the passkey, the code once.
  await page.getByRole("link", { name: "Staff", exact: true }).click();
  await page.getByRole("button", { name: "Add staff" }).click();
  const add = page.getByRole("dialog", { name: "Add staff" });
  await add.getByRole("textbox", { name: "Work email" }).fill(mei);
  await add.getByRole("radio", { name: "Operator" }).check();
  await add.getByRole("button", { name: "Add staff" }).click();
  await expect(
    stepUpDialog(page).getByText(`Use your second factor to add ${mei} to staff.`),
  ).toBeVisible();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  const shown = page.getByRole("dialog", { name: "Staff added" });
  await expect(
    shown.getByText(`Hand this code to ${mei} yourself. It works once, for 30 minutes.`),
  ).toBeVisible();
  const meiCode = (
    (await shown.locator("[data-slot=copy-field] .font-mono").textContent()) ?? ""
  ).trim();
  expect(meiCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(shown).toBeHidden();
  await dialogsGone(page);
  const meiRow = page.getByRole("row").filter({ hasText: mei });
  await expect(meiRow.getByText("Hasn’t signed in yet")).toBeVisible();
  await expect(meiRow.getByRole("cell", { name: "Operator", exact: true })).toBeVisible();
  // The code is shown once: it is nowhere on the page after Done.
  await expect(inApp(page).getByText(meiCode)).toHaveCount(0);

  // Change role: Operator to Viewer, confirmed with the passkey.
  await meiRow.getByRole("button", { name: `Change role of ${mei}` }).click();
  const change = page.getByRole("dialog", { name: "Change role" });
  await change.getByRole("radio", { name: "Viewer" }).check();
  await change.getByRole("button", { name: "Change role" }).click();
  await expect(
    stepUpDialog(page).getByText(`Use your second factor to change ${mei}’s role to Viewer.`),
  ).toBeVisible();
  await stepUpDialog(page).getByRole("button", { name: "Use my passkey" }).click();
  await expect(inApp(page).getByText("Role changed")).toBeVisible();
  await expect(meiRow.getByRole("cell", { name: "Viewer", exact: true })).toBeVisible();

  // Every step wrote its audit event.
  const events = (await server.audit()).map((e) => e.event);
  for (const event of [
    "staff.bootstrapped",
    "staff.enrolment_code_redeemed",
    "staff.factor_enrolled",
    "staff.factor_added",
    "staff.step_up_passed",
    "staff.member_added",
    "staff.enrolment_code_issued",
    "staff.role_changed",
  ]) {
    expect(events, event).toContain(event);
  }

  // Mei, in her own browser: the emailed code, the enrolment code once, a passkey; a Viewer.
  const meiContext = await newContext();
  await meiContext.credentials.install();
  const meiPage = await meiContext.newPage();
  await throughAccess(meiPage, mei, "/sign-in");
  await emailedCodeSignIn(meiPage, emailSink, mei);
  await enrol(meiPage, meiCode, "passkey");
  await expect(meiPage.getByRole("button", { name: "Add staff" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  const nadiaFromMei = meiPage.getByRole("row").filter({ hasText: nadia });
  await expect(nadiaFromMei.getByRole("button", { name: `Remove ${nadia}` })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  const asViewer = await meiPage.evaluate(async (email) => {
    const response = await fetch("/api/staff", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Fin-App": "admin",
      },
      body: JSON.stringify({ email, roleKey: "viewer" }),
    });
    return { status: response.status, code: ((await response.json()) as { code: string }).code };
  }, addresses.address("someone.else"));
  expect(asViewer).toEqual({ status: 403, code: "forbidden" });

  // Nadia's list now says when Mei signed in.
  await page.reload();
  await expect(
    page.getByRole("row").filter({ hasText: mei }).getByText("Hasn’t signed in yet"),
  ).toHaveCount(0);
});
