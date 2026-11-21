// What Fin Admin's journeys share: the API test server's control port (reset, the first Admin,
// the clock, the audit trail), passing Access as a member of staff, the emailed code, the
// authenticator's code at the server's time, and the enrolment of a bootstrapped Admin.

import { ACCESS_STAND_IN_PORT, appOrigin, type EmailSinkReader, totp } from "@fin/testing";
import { expect, signInThroughAccess, waitForReady } from "@fin/testing/playwright";
import type { Page } from "@playwright/test";
import { CONTROL_PORT } from "./server.ts";

export const ORIGIN = appOrigin("admin");
export const ACCESS =
  process.env.FIN_E2E_ACCESS_STAND_IN ?? `http://127.0.0.1:${ACCESS_STAND_IN_PORT}`;
const CONTROL = process.env.FIN_E2E_ADMIN_CONTROL ?? `http://127.0.0.1:${CONTROL_PORT}`;

async function control<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`the API test server's control answered ${response.status}`);
  return (await response.json()) as T;
}

export const server = {
  reset: () => control<{ ok: true }>("POST", "/reset"),
  /** `pnpm fin task <env> staff-bootstrap`: the first Admin, pending, and the code shown once. */
  bootstrap: (email: string) =>
    control<{ staffId: string; enrolmentCode: string }>("POST", "/bootstrap", { email }),
  /** Moves the server's clock on, as waiting does (the next authenticator step, an expiry). */
  advance: (seconds: number) => control<{ now: string }>("POST", "/clock", { seconds }),
  now: async () => Date.parse((await control<{ now: string }>("GET", "/clock")).now),
  audit: async () =>
    (await control<{ events: { event: string; target: string | null }[] }>("GET", "/audit")).events,
};

/** Passes Access as `email` and opens `path`; returns once the app is ready. */
export async function throughAccess(page: Page, email: string, path = "/"): Promise<void> {
  await signInThroughAccess(page, { standInOrigin: ACCESS, appOrigin: ORIGIN, email, path });
  await waitForReady(page);
}

/** The authenticator's code now, by the server's clock, after waiting for a fresh step. */
export async function authenticatorCode(key: string): Promise<string> {
  // A step's code works once (no reuse), so move to the next step first, as a person would wait.
  await server.advance(30);
  return totp(key.replace(/\s+/g, ""), await server.now());
}

/** The key the page shows for an authenticator app (`MFRG GZDF …`). */
export async function shownKey(page: Page): Promise<string> {
  const field = page.locator("[data-slot=copy-field]").filter({ hasText: "Key" });
  const text = ((await field.locator(".font-mono").textContent()) ?? "").trim();
  expect(text).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/);
  return text;
}

/** From sign-in, an emailed code: lands on the factor step or enrolment. */
export async function emailedCodeSignIn(
  page: Page,
  emailSink: EmailSinkReader,
  email: string,
): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin Admin" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Work email" })).toHaveValue(email);
  const mark = await emailSink.mark();
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  const code = await emailSink.waitForCode({ to: email, after: mark });
  await page.getByRole("textbox", { name: "Sign-in code" }).fill(code);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
}

/** A pending member's enrolment code, then the first factor; lands on Staff. */
export async function enrol(
  page: Page,
  enrolmentCode: string,
  first: "passkey" | "authenticator",
): Promise<string | null> {
  await expect(
    page.getByRole("heading", { level: 1, name: "Enter your enrolment code" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Enrolment code" }).fill(enrolmentCode);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a second factor" })).toBeVisible();
  let key: string | null = null;
  if (first === "passkey") {
    await page.getByRole("button", { name: "Add a passkey" }).click();
  } else {
    await page.getByRole("button", { name: "Use an authenticator app" }).click();
    key = await shownKey(page);
    await page
      .getByRole("textbox", { name: "Code from the app" })
      .fill(await authenticatorCode(key));
  }
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  return key;
}

/**
 * Waits until every dialog has finished closing (its exit and its focus return). A dialog opened
 * while another is still leaving closes again at once (open item for the UI kit), so a journey,
 * like a person, opens the next one after the last has gone.
 */
export async function dialogsGone(page: Page): Promise<void> {
  await expect(page.locator("[role=dialog], [role=alertdialog]")).toHaveCount(0);
}

/** The "Confirm it's you" dialog. */
export function stepUpDialog(page: Page) {
  return page.getByRole("dialog", { name: "Confirm it’s you" });
}
