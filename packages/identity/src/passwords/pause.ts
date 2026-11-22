// The pause after repeated wrong passwords (spec 02 §5.7, §5.6; [SA-06]). Wrong passwords for an
// address from browsers its account does not know are counted per network (10 in 15 minutes, 15 in
// an hour) and across every network (40 in an hour). The try that reaches a limit starts a pause:
// password sign-in for that address from browsers it does not know is refused, from that network
// (a per-network limit) or from anywhere (the all-networks limit), until the window that filled
// ends. A browser the account knows is never counted and never paused, and a passkey or an emailed
// code signs in whatever happens here. Sign-ins of one address take turns (flows.ts takes the
// address's lock first), so each try sees the count and the pause the one before it left.
//
// Counting is per address whether or not an account has it, so the pause says nothing about which
// addresses are registered (T-SAT-32). Counts live in ops.rate_window; the pause itself in the
// logged ops.lockout, so a restart keeps a paused address paused (T-SAT-33). When a pause starts
// for an address with an account, `password.paused` is written and `password-paused` goes to the
// address, at most once a day.
//
// Resetting the password lifts the address's pauses and starts its counts again from none. Every
// count and pause is kept under the address's generation (a row of ops.lockout, 0 until the first
// reset), and a reset moves the address to the next one: the counts and pauses of the generations
// before are never read again, and nothing scans either table for them. ops.sweep_rate_windows
// removes the old counts as it removes every count; an old pause row stays, ended, as every
// lockout row does.
import { audit, notify } from "../hooks/shared.ts";
import { LimitStoreError, type LimitWindow } from "../limits.ts";
import { DAY, HOUR, MINUTE } from "../ports/clock.ts";
import type { UnitTx } from "../ports/db.ts";
import type { RequestState } from "../request.ts";
import type { RealmRuntime } from "../runtime.ts";

/** A pause starts on the wrong password that reaches one of these counts. */
export const PAUSE_THRESHOLDS = {
  network: [
    { ms: 15 * MINUTE, count: 10 },
    { ms: HOUR, count: 15 },
  ],
  address: [{ ms: HOUR, count: 40 }],
} as const;

/** The limiter refuses past `max`; the try that reaches the count is the one that pauses. */
function windowsOf(rules: readonly { ms: number; count: number }[]): LimitWindow[] {
  return rules.map((r) => ({ ms: r.ms, max: r.count - 1 }));
}

export const PAUSE_EMAIL_EVERY_MS = DAY;

/** The address's bucket: its keyed hash under the newest limit key, never the address itself. */
function addressBucket(rt: RealmRuntime, email: string): string {
  return rt.hasher.bucket("email", email.toLowerCase());
}

/** The ops.lockout row whose count is the address's generation. */
function generationKey(address: string): string {
  return `password_generation:${address}`;
}

/** Reads or moves the generation the way the limiter treats its own tables: a failure is a 503. */
async function generationQuery(
  tx: UnitTx,
  rt: RealmRuntime,
  text: string,
  values: readonly unknown[],
): Promise<number> {
  try {
    const result = await tx.query<{ count: number }>(text, values);
    return Number(result.rows[0]?.count ?? 0);
  } catch (error) {
    rt.lines.write("limits.store_failed", "error", { bucket: "password_generation" });
    throw new LimitStoreError("password_generation", { cause: error });
  }
}

/** The address's generation: 0 until its first reset, then one more for each. */
async function generationOf(tx: UnitTx, rt: RealmRuntime, address: string): Promise<number> {
  return generationQuery(tx, rt, "SELECT count FROM ops.lockout WHERE key = $1", [
    generationKey(address),
  ]);
}

/** The counter subjects and pause keys of an address in one generation: each one exact key. */
interface PauseKeys {
  /** `password_wrong_address` counts under it, across every network. */
  address: string;
  /** `password_wrong_network` counts under it, from one network. */
  network: string;
  addressLock: string;
  networkLock: string;
}

function pauseKeys(
  rt: RealmRuntime,
  address: string,
  generation: number,
  network: string,
): PauseKeys {
  const scope = `${address}:${generation}`;
  const net = rt.hasher.bucket("network", network);
  return {
    address: scope,
    network: `${scope}:${net}`,
    addressLock: `password_pause:${scope}`,
    networkLock: `password_pause:${scope}:${net}`,
  };
}

function later(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Until when password sign-in is paused for this address from this network, or null. */
export async function passwordPausedUntil(
  tx: UnitTx,
  rt: RealmRuntime,
  email: string,
  network: string,
): Promise<Date | null> {
  const address = addressBucket(rt, email);
  const keys = pauseKeys(rt, address, await generationOf(tx, rt, address), network);
  return later(
    await rt.limits.lockedUntil(tx, keys.addressLock),
    await rt.limits.lockedUntil(tx, keys.networkLock),
  );
}

export interface WrongPasswordInput {
  email: string;
  network: string;
  /** The account with the address, when there is one (it is told; the count is the same). */
  person: { id: string; email: string } | null;
}

/** Counts one wrong password from a browser the account does not know; may start a pause. */
export async function countWrongPassword(
  tx: UnitTx,
  rt: RealmRuntime,
  state: RequestState,
  input: WrongPasswordInput,
): Promise<{ pausedUntil: Date | null }> {
  const address = addressBucket(rt, input.email);
  const keys = pauseKeys(rt, address, await generationOf(tx, rt, address), input.network);
  const network = await rt.limits.consumeWindows(
    tx,
    "password_wrong_network",
    windowsOf(PAUSE_THRESHOLDS.network),
    keys.network,
  );
  const allNetworks = await rt.limits.consumeWindows(
    tx,
    "password_wrong_address",
    windowsOf(PAUSE_THRESHOLDS.address),
    keys.address,
  );
  let pausedUntil: Date | null = null;
  let scope: "network" | "address" | null = null;
  if (!network.allowed && network.resetAt !== null) {
    await rt.limits.lock(tx, keys.networkLock, "password_pause", network.resetAt);
    pausedUntil = network.resetAt;
    scope = "network";
  }
  if (!allNetworks.allowed && allNetworks.resetAt !== null) {
    await rt.limits.lock(tx, keys.addressLock, "password_pause", allNetworks.resetAt);
    pausedUntil = later(pausedUntil, allNetworks.resetAt);
    scope = "address";
  }
  if (pausedUntil === null || scope === null) return { pausedUntil: null };

  rt.lines.write("auth.password_paused", "warn", {
    scope,
    ...(input.person === null ? {} : { userId: input.person.id }),
  });
  const person = input.person;
  if (person !== null) {
    // The pause is Fin's doing, not the account holder's: whoever typed the passwords is unknown.
    await audit(rt, tx, state, {
      event: "password.paused",
      personId: person.id,
      actor: { kind: "system", id: null, via: "console" },
      target: person.id,
      metadata: { scope, until: pausedUntil.toISOString() },
    });
    const daily = `password_paused_email:${person.id}`;
    if ((await rt.limits.lockedUntil(tx, daily)) === null) {
      const now = rt.clock.now();
      await rt.limits.lock(
        tx,
        daily,
        "password_paused_email",
        new Date(now.getTime() + PAUSE_EMAIL_EVERY_MS),
      );
      await notify(rt, tx, "identity/password-paused", person.email, {
        userId: person.id,
        time: now.toISOString(),
      });
    }
  }
  return { pausedUntil };
}

/**
 * Lifts the address's pauses and starts its counts again (a reset proved the mailbox and replaced
 * the password): the address moves to its next generation, one row by its own key, so the first
 * wrong try after a reset does not pause the address again at once. Returns the new generation.
 */
export async function liftPasswordPauses(
  tx: UnitTx,
  rt: RealmRuntime,
  email: string,
): Promise<number> {
  return generationQuery(
    tx,
    rt,
    `INSERT INTO ops.lockout (key, kind, count, locked_until, updated_at)
     VALUES ($1, 'password_generation', 1, NULL, $2)
     ON CONFLICT (key) DO UPDATE
       SET count = ops.lockout.count + 1, kind = EXCLUDED.kind, locked_until = NULL,
           updated_at = EXCLUDED.updated_at
     RETURNING count`,
    [generationKey(addressBucket(rt, email)), rt.clock.now()],
  );
}

/** Lifts a person's authenticator lockout (§5.7: a reset lifts it). */
export async function liftFactorLockout(tx: UnitTx, rt: RealmRuntime, key: string): Promise<void> {
  await tx.query(
    "UPDATE ops.lockout SET count = 0, locked_until = NULL, updated_at = $2 WHERE key = $1",
    [key, rt.clock.now()],
  );
}
