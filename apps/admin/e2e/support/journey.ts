// What Fin Admin's journeys share: the API test server's control port (reset, the first Admin,
// the clock, the audit trail), passing Access as a member of staff, the emailed code, the
// authenticator's code at the server's time, and the enrolment of a bootstrapped Admin.

import { ACCESS_STAND_IN_PORT, appOrigin, type EmailSinkReader, totp } from "@fin/testing";
import { expect, signInThroughAccess, waitForReady } from "@fin/testing/playwright";
import type { Locator, Page } from "@playwright/test";
import { CONTROL_PORT } from "./server.ts";

export const ORIGIN = appOrigin("admin");

/** Sign-in after the session ended: `?ended=1`, which the router may write back as `?ended=true`. */
export const ENDED_URL = new RegExp(
  `^${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sign-in\\?ended=(1|true)$`,
);

/**
 * The app's own document, without the SDK's live regions: an alert's words are also put in a
 * screen-reader region a moment later, so a text looked up in the whole page can match twice.
 */
export function inApp(page: Page): Locator {
  return page.locator("#root");
}
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
    (
      await control<{
        events: {
          event: string;
          target: string | null;
          metadata: Readonly<Record<string, unknown>>;
        }[];
      }>("GET", "/audit")
    ).events,
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

/**
 * `count` different codes the authenticator does not show now, nor one step either side, by the
 * server's clock: each is a wrong try, and no two are the same, so each one is typed afresh.
 */
export async function wrongCodes(key: string, count: number): Promise<string[]> {
  const secret = key.replace(/\s+/g, "");
  const now = await server.now();
  const valid = new Set([-60_000, -30_000, 0, 30_000, 60_000].map((d) => totp(secret, now + d)));
  const codes: string[] = [];
  for (let n = 1; codes.length < count; n += 1) {
    const code = String((n * 104_729) % 1_000_000).padStart(6, "0");
    if (!valid.has(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Types one authenticator code into `box` and waits for the realm's answer and for the page to be
 * ready for the next one (`button` no longer busy). Returns the answer's status and code.
 */
export async function tryCode(
  page: Page,
  box: Locator,
  button: Locator,
  code: string,
): Promise<{ status: number; code: string | null; reason: string | null }> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/two-factor/verify-totp") &&
      response.request().method() === "POST",
  );
  await box.fill(code);
  const response = await answered;
  const body = (await response.json().catch(() => ({}))) as { code?: unknown; reason?: unknown };
  await expect(button).not.toHaveAttribute("aria-busy", "true");
  return {
    status: response.status(),
    code: typeof body.code === "string" ? body.code : null,
    reason: typeof body.reason === "string" ? body.reason : null,
  };
}

/**
 * Holds every request to `url` until `release()`: the screen's waiting state stays on screen long
 * enough to check, as on a slow connection.
 */
export async function hold(page: Page, url: string): Promise<{ release: () => void }> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    await held;
    await route.fallback();
  });
  return { release };
}

/**
 * The next passkey prompt ends the way the browser ends it when the person closes it
 * (`NotAllowedError`), or with another of WebAuthn's errors (`UnknownError`: the authenticator
 * refused). Only that one prompt: the next works again.
 */
export async function endNextPasskeyPrompt(
  page: Page,
  kind: "create" | "get",
  name: "NotAllowedError" | "UnknownError" = "NotAllowedError",
): Promise<void> {
  await page.evaluate(
    ({ kind, name }) => {
      const credentials = navigator.credentials as unknown as Record<string, unknown>;
      const original = credentials[kind];
      credentials[kind] = async () => {
        credentials[kind] = original;
        throw new DOMException("The prompt ended without a passkey.", name);
      };
    },
    { kind, name },
  );
}

/** From the next document on, this browser has no WebAuthn at all (`PublicKeyCredential` gone). */
export async function withoutPasskeys(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
  });
}

/** Asks the server to redeem an enrolment code for the page's session; its status and reason. */
export async function redeemFromPage(
  page: Page,
  code: string,
): Promise<{ status: number; reason: string | null }> {
  return page.evaluate(async (value) => {
    const response = await fetch("/api/enrolment/redeem", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Fin-App": "admin",
      },
      body: JSON.stringify({ code: value }),
    });
    const body = (await response.json().catch(() => ({}))) as { reason?: unknown };
    return {
      status: response.status,
      reason: typeof body.reason === "string" ? body.reason : null,
    };
  }, code);
}

/** The viewer's state as the server answers it now, for the page's session. */
export async function viewerState(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/viewer", { headers: { Accept: "application/json" } });
    return ((await response.json()) as { state: string }).state;
  });
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

/**
 * Fin Admin's home for a prebuilt role: the first navigation item whose screen exists (spec 06
 * §7.2, S6-25), the Audit log until Production access is built. Where a sign-in ends.
 */
export const HOME = { url: `${ORIGIN}/audit`, heading: "Audit log" } as const;

/** Checks the page is Fin Admin's home. */
export async function expectHome(page: Page): Promise<void> {
  await expect(page).toHaveURL(HOME.url);
  await expect(page.getByRole("heading", { level: 1, name: HOME.heading })).toBeVisible();
}

/** A pending member's enrolment code, then the first factor; lands on home, then opens Staff. */
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
  await expectHome(page);
  await page.getByRole("link", { name: "Staff", exact: true }).click();
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
