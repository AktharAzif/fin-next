// T-SAT-64 (spec 02 §19.3): signing in to Fin Admin with an emailed code or a passkey alone; a
// wrong code says so; someone Access lets in who is not staff sees the same screens and gets no
// code; signing out ends with sign-in; and the sign-in page draws in light and dark.
import { expect, test } from "@fin/testing/playwright";
import { enrol, expectHome, inApp, ORIGIN, server, throughAccess } from "../support/journey.ts";

test.beforeEach(async () => {
  await server.reset();
});

test("@journey a wrong emailed code, then a passkey alone after signing out", async ({
  page,
  authenticator,
  emailSink,
  addresses,
}) => {
  const nadia = addresses.address("nadia.brooks");
  const { enrolmentCode } = await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");

  const mark = await emailSink.mark();
  await page.getByRole("button", { name: "Email me a code" }).click();
  const code = await emailSink.waitForCode({ to: nadia, after: mark });
  const wrong = code === "00000000" ? "11111111" : "00000000";
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(wrong);
  await expect(inApp(page).getByText("That code didn’t work.")).toBeVisible();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
  await enrol(page, enrolmentCode, "passkey");
  expect(await authenticator.list(authenticator.rpIdFor(ORIGIN))).toHaveLength(1);

  // Log out: a full load of sign-in, and the session is gone.
  await page.getByRole("button", { name: `Account menu, ${nadia}` }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin Admin" })).toBeVisible();

  // A passkey alone signs a member of staff in (aal2): no code, no factor step.
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expectHome(page);
  const events = (await server.audit()).filter((e) => e.event === "staff.signed_in");
  expect(events.length).toBeGreaterThanOrEqual(2);
});

test("@journey someone Access lets in who is not staff sees the same screens, and no code is sent", async ({
  page,
  emailSink,
  addresses,
}) => {
  await server.bootstrap(addresses.address("nadia.brooks"));
  const stranger = addresses.address("stranger");
  await throughAccess(page, stranger, "/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  const mark = await emailSink.mark();
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  await expect(inApp(page).getByText(`Enter the code we emailed to ${stranger}.`)).toBeVisible();
  await page.getByRole("textbox", { name: "Sign-in code" }).fill("12345678");
  await expect(inApp(page).getByText("That code didn’t work.")).toBeVisible();
  expect((await emailSink.list({ to: stranger, after: mark })).messages).toHaveLength(0);
});

test("@journey the work email is checked before anything is sent", async ({ page, addresses }) => {
  const nadia = addresses.address("nadia.brooks");
  await server.bootstrap(nadia);
  await throughAccess(page, nadia, "/sign-in");
  const field = page.getByRole("textbox", { name: "Work email" });
  await field.fill("");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(inApp(page).getByText("Enter an email address.")).toBeVisible();
  await field.fill("nadia@example.org");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(inApp(page).getByText("Enter a work email address.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin Admin" })).toBeVisible();
});

test("@visual the sign-in page draws in the system theme, light or dark", async ({
  page,
  addresses,
}, testInfo) => {
  await throughAccess(page, addresses.address("nadia.brooks"), "/sign-in?ended=1");
  const dark = testInfo.project.use.colorScheme === "dark";
  await expect(page.locator("html")).toHaveAttribute("data-theme", dark ? "dark" : "light");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin Admin" })).toBeVisible();
  await expect(inApp(page).getByText("You were signed out. Sign in again.")).toBeVisible();
});
