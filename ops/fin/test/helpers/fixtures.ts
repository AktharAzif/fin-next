// Test fixtures. Every ID-, token- and address-shaped value is built at run time (CONTRIBUTING,
// "Tests that need a secret-shaped value"), so no tracked file holds one, and every address uses
// example.com, example.org or example.net.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecResult,
  FetchFn,
  ForcedClose,
  Runtime,
  StopCause,
  StopHandlers,
} from "../../src/core/runtime.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** A hex string of the given length, built so that no source line holds one. */
export function hex(length: number, seed = "a"): string {
  return seed.repeat(length).slice(0, length);
}

export function uuid(seed = "b"): string {
  return [hex(8, seed), hex(4, seed), hex(4, seed), hex(4, seed), hex(12, seed)].join("-");
}

export const ZONE = "zone.example";
export const ACCOUNT_ID = hex(32, "1");
export const ZONE_ID = hex(32, "2");

export function overlayFixture() {
  return {
    environment: "staging",
    zone: ZONE,
    hosts: {
      console: `console.${ZONE}`,
      admin: `staff.${ZONE}`,
      verify: `onboard.${ZONE}`,
      selfie: `selfie.${ZONE}`,
      docs: `docs.${ZONE}`,
      api: `gateway.${ZONE}`,
      pg: `pg.${ZONE}`,
    },
    emailSubdomains: { auth: `auth.${ZONE}`, notify: `notify.${ZONE}` },
    cloudflare: {
      accountId: ACCOUNT_ID,
      accountName: "fixture account",
      zoneId: ZONE_ID,
      accessAuthDomain: "fixture-team.cloudflareaccess.com",
    },
    railway: { projectId: uuid("c"), environmentId: uuid("d") },
    access: { staff: ["staff.member@example.com"], allowDomains: ["example.org"] },
    email: { seedInbox: "seed@example.net" },
    refuseList: ["old-product-name", ZONE],
    allowedNames: {
      _comment: "fixture",
      labels: [
        "console",
        "staff",
        "onboard",
        "selfie",
        "docs",
        "gateway",
        "pg",
        "auth",
        "notify",
        "_dmarc.auth",
        "_dmarc.notify",
      ],
      spikeOnly: ["c1-spike", "c1-spike-admin"],
      fallbackOnly: ["console-api", "staff-api", "onboard-api"],
    },
    neverTouch: { _comment: "fixture", labels: ["@", "_dmarc", "www", "legacy", "app"] },
    dmarc: { records: ["_dmarc.auth", "_dmarc.notify"], policy: "p=reject", note: "fixture" },
    staticEgress: { worker: ["203.0.113.10", "203.0.113.11"] },
    thresholds: { "api-v4": 100 },
  };
}

export function tempDir(prefix = "fin-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes a file readable by its owner only, as credential and overlay files must be. */
export function writePrivate(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function writeOverlay(dir: string, overlay: unknown = overlayFixture()): string {
  return writePrivate(dir, "overlay.json", JSON.stringify(overlay));
}

/** A token-shaped value built at run time. */
export function fakeToken(name: string): string {
  return `tok${name}${"x".repeat(20)}${name.length}`;
}

export interface FakeRuntime extends Runtime {
  out(): string;
  err(): string;
  /** Both streams, in the order they were written (what a CI job log shows). */
  all(): string;
  advance(ms: number): void;
  /** Delivers a stop to the trapped handlers, as the real runtime would; false when none is. */
  interrupt(cause: StopCause): Promise<boolean>;
  /** Closes the trapped run at once, as the real runtime does before it exits; false when none is. */
  forceClose(why: ForcedClose): boolean;
}

export interface FakeRuntimeOptions {
  env?: Record<string, string | undefined>;
  fetch?: FetchFn;
  exec?: (program: string, args: readonly string[]) => ExecResult;
  repoRoot?: string;
  start?: Date;
  /** Whether the checkout has local changes (default: clean). */
  dirty?: boolean;
  /** How the runtime waits (default: at once, so no test waits on a clock). */
  sleep?: (ms: number) => Promise<void>;
}

export function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  let stdout = "";
  let stderr = "";
  let all = "";
  let now = (options.start ?? new Date("2026-11-21T06:00:00.000Z")).getTime();
  let counter = 0;
  let trapped: StopHandlers | undefined;
  return {
    env: options.env ?? {},
    repoRoot: options.repoRoot ?? REPO_ROOT,
    now: () => new Date(now),
    random: (bytes) => {
      counter++;
      return new Uint8Array(bytes).map((_, i) => (i * 7 + counter * 13) % 256);
    },
    fetch:
      options.fetch ??
      (async () => {
        throw new Error("no network in tests");
      }),
    sleep: options.sleep ?? (async () => {}),
    stdout: (text) => {
      stdout += text;
      all += text;
    },
    stderr: (text) => {
      stderr += text;
      all += text;
    },
    operator: () => "operator",
    commit: () => hex(40, "e"),
    dirty: () => options.dirty ?? false,
    exec: options.exec ?? (() => ({ status: 127, stdout: "", stderr: "not available in tests" })),
    trap: (handlers) => {
      trapped = handlers;
      return () => {
        if (trapped === handlers) trapped = undefined;
      };
    },
    out: () => stdout,
    err: () => stderr,
    all: () => all,
    advance: (ms) => {
      now += ms;
    },
    interrupt: async (cause) => {
      const handlers = trapped;
      if (handlers === undefined) return false;
      await handlers.stop(cause);
      return true;
    },
    forceClose: (why) => {
      const handlers = trapped;
      if (handlers === undefined) return false;
      handlers.closeNow(why);
      return true;
    },
  };
}

/** The environment a command run needs: an overlay and a state directory in a temp dir. */
export function commandEnv(extra: Record<string, string> = {}): {
  env: Record<string, string>;
  dir: string;
} {
  const dir = tempDir();
  return {
    dir,
    env: { FIN_OVERLAY_FILE: writeOverlay(dir), FIN_STATE_DIR: join(dir, "state"), ...extra },
  };
}

/** Every private value of the fixture overlay, for leak assertions. */
export function privateValues(): string[] {
  return [
    ZONE,
    ACCOUNT_ID,
    ZONE_ID,
    uuid("c"),
    uuid("d"),
    "staff.member@example.com",
    "example.org",
    "seed@example.net",
    "fixture-team.cloudflareaccess.com",
  ];
}
