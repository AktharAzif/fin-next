// The shared Playwright fixtures every journey imports (spec 06 §10.2; spec 02 §19.3):
//
//   test("...", async ({ page, csp, offsite, authenticator, emailSink, addresses, clock }) => ...)
//
// On every context, before its first page: the `securitypolicyviolation` recorder and the
// off-origin request recorder (both fail the test at its end if they saw anything), and the
// browser clock at the test's clock (`testClock`): the test's own `clockTime` when it sets one,
// else the run's clock, FIN_E2E_CLOCK, which the stand-ins and the servers read too ("fixed" pins
// Date, the default; "paused" also stops timers; "off" leaves the clock alone, the default for a
// "wall" run that sets no `clockTime`). The Node-side `clock` starts at the same time. The Access
// stand-in's origin may be navigated to (its login page stands in front of Fin Admin) but nothing
// may load from it.
//
// No test turns bypassCSP on (spec 06 §6.4). Every test, whichever fixtures it uses, is refused
// when its resolved options turn it on (its project, a `test.use`, `contextOptions`), because
// Playwright starts every context the test makes from them, a `browser.newContext()` of its own
// included. `newContext()` also refuses its own options and pins the page policy on.
import { type BrowserContext, type BrowserContextOptions, test as base } from "@playwright/test";
import { type AddressBook, createAddressBook, testScope } from "../canon/addresses.ts";
import {
  type BrowserClockMode,
  FrozenClock,
  freezeBrowserClock,
  resolveTestClock,
  type TestClock,
} from "../clock.ts";
import { EmailSinkReader } from "../email/reader.ts";
import { ACCESS_STAND_IN_PORT, EMAIL_SINK_PORT } from "../static-host/apps.ts";
import { installAuthenticator, type VirtualAuthenticator } from "./authenticator.ts";
import { type CspWatcher, watchCsp } from "./csp.ts";
import { type OffsiteWatcher, watchOffsite } from "./offsite.ts";

export interface FinOptions {
  /** Origins a page may load from besides the project's baseURL (the selfie page's Sumsub hosts). */
  readonly allowedOrigins: readonly string[];
  /**
   * How the browser clock runs. Unset: "fixed" when the test sets `clockTime`, else the run's
   * (`journeyClock`: "fixed", or "off" in a "wall" run).
   */
  readonly clockMode: BrowserClockMode | undefined;
  /**
   * Where the browser clock and the Node-side `clock` start, in every run ("wall" included). Unset:
   * where the run's clock stands as the test starts.
   */
  readonly clockTime: string | undefined;
  readonly emailSinkOrigin: string;
  /** The Access stand-in: a top-level navigation may reach it; nothing may load from it. */
  readonly accessStandInOrigin: string;
}

export interface FinFixtures {
  readonly csp: CspWatcher;
  readonly offsite: OffsiteWatcher;
  readonly authenticator: VirtualAuthenticator;
  readonly emailSink: EmailSinkReader;
  readonly addresses: AddressBook;
  /**
   * The test's clock, from `clockMode`, `clockTime` and the run's clock together
   * (`resolveTestClock`), worked out once as the test starts: what every context's browser clock
   * and the Node-side `clock` start from.
   */
  readonly testClock: TestClock;
  /**
   * The Node-side frozen clock, standing where the browser clock starts (`testClock.time`). When
   * the browser keeps the system clock ("off": a "wall" run that sets no `clockTime`), this one
   * stands at the test's start.
   */
  readonly clock: FrozenClock;
  /**
   * A second browser context (another person, another device) with the same recorders and
   * clock as the test's own, and the page policy pinned on; closed and checked when the test ends.
   */
  readonly newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
}

/** Fixtures every test runs, whether it names them or not. */
interface FinAutomaticFixtures {
  /** Refuses bypassCSP from the test's resolved options (`refuseResolvedBypassCsp`). */
  readonly pagePolicy: undefined;
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

/**
 * Spec 06 §6.4: no Fin test turns the page policy off. Throws, naming where it was turned on, when
 * `options` sets bypassCSP.
 */
export function refuseBypassCsp(
  where: string,
  options: { readonly bypassCSP?: boolean | undefined } | undefined,
): void {
  if (options?.bypassCSP) {
    throw new Error(`no Fin test runs with bypassCSP (spec 06 §6.4); ${where} turns it on`);
  }
}

/** The test's resolved options that Playwright starts each of its contexts from. */
export interface ResolvedContextOptions {
  /** The project's, the file's or a describe block's `test.use`, else `contextOptions`'s. */
  readonly bypassCSP: boolean | undefined;
  readonly contextOptions: BrowserContextOptions | undefined;
}

/**
 * Refuses bypassCSP from a test's resolved options. Playwright fills every context the test makes
 * from them (the `context` fixture's, `newContext()`'s and a `browser.newContext()` of the test's
 * own), so the fixtures run this for every test, whichever fixtures it names.
 */
export function refuseResolvedBypassCsp({
  bypassCSP,
  contextOptions,
}: ResolvedContextOptions): void {
  refuseBypassCsp("the test's options", { bypassCSP });
  refuseBypassCsp("contextOptions", contextOptions);
}

/**
 * The options `newContext()` makes a context with: the caller's, refused when they turn bypassCSP
 * on, and bypassCSP pinned off, so no option Playwright fills in from the test's can turn the page
 * policy off (it fills only what the caller left out).
 */
export function secondContextOptions(options: BrowserContextOptions = {}): BrowserContextOptions {
  refuseBypassCsp("newContext()", options);
  return { ...options, bypassCSP: false };
}

interface Preparation {
  readonly baseURL: string | undefined;
  readonly allowedOrigins: readonly string[];
  /** Origins only a top-level navigation may reach (the Access stand-in's). */
  readonly navigationOrigins?: readonly string[];
  /** The test's clock (`testClock`), the same for every context the test makes. */
  readonly clock: TestClock;
}

/** Puts the recorders and the frozen clock on a context before its first page. */
export async function prepareContext(
  context: BrowserContext,
  { baseURL, allowedOrigins, navigationOrigins = [], clock }: Preparation,
): Promise<Watchers> {
  const csp = await watchCsp(context);
  const origins = baseURL === undefined ? [...allowedOrigins] : [baseURL, ...allowedOrigins];
  const offsite = watchOffsite(context, origins, { navigationOrigins });
  const prepared = { csp, offsite };
  watchers.set(context, prepared);
  if (clock.mode !== "off") await freezeBrowserClock(context, clock.time, clock.mode);
  return prepared;
}

type FinTestFixtures = FinOptions & FinFixtures & FinAutomaticFixtures;

export const test = base.extend<FinTestFixtures, { runId: string }>({
  allowedOrigins: [[], { option: true }],
  // Unset unless the test sets them; `testClock` fills them in from the run's clock.
  clockMode: [undefined, { option: true }],
  clockTime: [undefined, { option: true }],
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

  // Before the test's own fixtures, and before any context it makes however it makes it.
  pagePolicy: [
    async ({ bypassCSP, contextOptions }, use) => {
      refuseResolvedBypassCsp({ bypassCSP, contextOptions });
      await use(undefined);
    },
    { auto: true, title: "the page policy stays on" },
  ],

  // The mode and the time in one place, read as the test starts (after its hooks), so the browser
  // clock of every context and the Node-side clock start together.
  testClock: async ({ clockMode, clockTime }, use) => {
    await use(resolveTestClock({ clockMode, clockTime }));
  },

  context: async ({ context, baseURL, allowedOrigins, accessStandInOrigin, testClock }, use) => {
    const prepared = await prepareContext(context, {
      baseURL,
      allowedOrigins,
      navigationOrigins: [accessStandInOrigin],
      clock: testClock,
    });
    await use(context);
    prepared.csp.assertNone();
    prepared.offsite.assertNone();
  },

  newContext: async ({ browser, baseURL, allowedOrigins, accessStandInOrigin, testClock }, use) => {
    const made: Array<{ context: BrowserContext; watchers: Watchers }> = [];
    await use(async (options = {}) => {
      // Inside a test, browser.newContext() fills what `options` leaves out from the test's own
      // options (the project's `use`, a `test.use`), which `pagePolicy` has already checked.
      const context = await browser.newContext(secondContextOptions(options));
      made.push({
        context,
        watchers: await prepareContext(context, {
          baseURL,
          allowedOrigins,
          navigationOrigins: [accessStandInOrigin],
          clock: testClock,
        }),
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
    await use(createAddressBook(testScope(runId, testInfo.testId, testInfo.retry)));
  },

  clock: async ({ testClock }, use) => {
    await use(new FrozenClock(testClock.time));
  },
});

export { expect } from "@playwright/test";
