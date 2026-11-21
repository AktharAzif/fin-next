// The shared Playwright fixtures every journey imports (spec 06 §10.2; spec 02 §19.3):
//
//   test("...", async ({ page, csp, offsite, authenticator, emailSink, addresses, clock }) => ...)
//
// On every context, before its first page: the `securitypolicyviolation` recorder and the
// off-origin request recorder (both fail the test at its end if they saw anything), and the
// browser clock frozen at the canon's time ("fixed" pins Date; "paused" also stops timers; "off"
// leaves the clock alone). A project that sets bypassCSP is refused.
import { createHash } from "node:crypto";
import { type BrowserContext, type BrowserContextOptions, test as base } from "@playwright/test";
import { type AddressBook, createAddressBook } from "../canon/addresses.ts";
import { CANON_TIME, FrozenClock, freezeBrowserClock } from "../clock.ts";
import { EmailSinkReader } from "../email/reader.ts";
import { ACCESS_STAND_IN_PORT, EMAIL_SINK_PORT } from "../static-host/apps.ts";
import { installAuthenticator, type VirtualAuthenticator } from "./authenticator.ts";
import { type CspWatcher, watchCsp } from "./csp.ts";
import { type OffsiteWatcher, watchOffsite } from "./offsite.ts";

export interface FinOptions {
  /** Origins a page may load from besides the project's baseURL (the selfie page's Sumsub hosts). */
  readonly allowedOrigins: readonly string[];
  readonly clockMode: "fixed" | "paused" | "off";
  readonly clockTime: string;
  readonly emailSinkOrigin: string;
  readonly accessStandInOrigin: string;
}

export interface FinFixtures {
  readonly csp: CspWatcher;
  readonly offsite: OffsiteWatcher;
  readonly authenticator: VirtualAuthenticator;
  readonly emailSink: EmailSinkReader;
  readonly addresses: AddressBook;
  /** The Node-side frozen clock at the same moment as the browser's. */
  readonly clock: FrozenClock;
  /**
   * A second browser context (another person, another device) with the same recorders and
   * clock as the test's own; closed and checked when the test ends.
   */
  readonly newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
}

interface Watchers {
  readonly csp: CspWatcher;
  readonly offsite: OffsiteWatcher;
}

const watchers = new WeakMap<BrowserContext, Watchers>();

function watchersOf(context: BrowserContext): Watchers {
  const found = watchers.get(context);
  if (found === undefined) throw new Error("the Fin context fixture did not run");
  return found;
}

interface Preparation {
  readonly baseURL: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly clockMode: FinOptions["clockMode"];
  readonly clockTime: string;
}

/** Puts the recorders and the frozen clock on a context before its first page. */
export async function prepareContext(
  context: BrowserContext,
  { baseURL, allowedOrigins, clockMode, clockTime }: Preparation,
): Promise<Watchers> {
  const csp = await watchCsp(context);
  const origins = baseURL === undefined ? [...allowedOrigins] : [baseURL, ...allowedOrigins];
  const offsite = watchOffsite(context, origins);
  const prepared = { csp, offsite };
  watchers.set(context, prepared);
  if (clockMode !== "off") await freezeBrowserClock(context, clockTime, clockMode);
  return prepared;
}

export const test = base.extend<FinOptions & FinFixtures, { runId: string }>({
  allowedOrigins: [[], { option: true }],
  clockMode: ["fixed", { option: true }],
  clockTime: [CANON_TIME, { option: true }],
  emailSinkOrigin: [
    process.env.FIN_E2E_EMAIL_SINK ?? `http://127.0.0.1:${EMAIL_SINK_PORT}`,
    { option: true },
  ],
  accessStandInOrigin: [
    process.env.FIN_E2E_ACCESS_STAND_IN ?? `http://127.0.0.1:${ACCESS_STAND_IN_PORT}`,
    { option: true },
  ],

  runId: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture signature
    async ({}, use) => {
      const given = process.env.FIN_E2E_RUN_ID;
      await use(given !== undefined && given !== "" ? given : Date.now().toString(36));
    },
    { scope: "worker" },
  ],

  context: async ({ context, baseURL, allowedOrigins, clockMode, clockTime }, use, testInfo) => {
    if (testInfo.project.use.bypassCSP === true) {
      throw new Error("no Fin test runs with bypassCSP (spec 06 §6.4)");
    }
    const prepared = await prepareContext(context, {
      baseURL,
      allowedOrigins,
      clockMode,
      clockTime,
    });
    await use(context);
    prepared.csp.assertNone();
    prepared.offsite.assertNone();
  },

  newContext: async ({ browser, baseURL, allowedOrigins, clockMode, clockTime }, use) => {
    const made: Array<{ context: BrowserContext; watchers: Watchers }> = [];
    await use(async (options = {}) => {
      // Inside a test, browser.newContext() starts from the project's `use` options.
      const context = await browser.newContext(options);
      made.push({
        context,
        watchers: await prepareContext(context, { baseURL, allowedOrigins, clockMode, clockTime }),
      });
      return context;
    });
    for (const { context } of made) await context.close();
    for (const { watchers: seen } of made) {
      seen.csp.assertNone();
      seen.offsite.assertNone();
    }
  },

  csp: async ({ context }, use) => {
    await use(watchersOf(context).csp);
  },

  offsite: async ({ context }, use) => {
    await use(watchersOf(context).offsite);
  },

  authenticator: async ({ context }, use) => {
    await use(await installAuthenticator(context));
  },

  emailSink: async ({ emailSinkOrigin }, use) => {
    await use(new EmailSinkReader(emailSinkOrigin));
  },

  addresses: async ({ runId }, use, testInfo) => {
    const test = createHash("sha256").update(testInfo.testId).digest("hex").slice(0, 8);
    await use(createAddressBook(`${runId}-${test}-r${testInfo.retry}`));
  },

  clock: async ({ clockTime }, use) => {
    await use(new FrozenClock(clockTime));
  },
});

export { expect } from "@playwright/test";
