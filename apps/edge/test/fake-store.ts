// An in-memory KeyStore for the edge's unit tests: the records a view would return, the windows by
// key, "last used" and a count of every statement, so a test can prove a refusal reached no
// database (T05-10, T05-42). Several edge replicas may share one store, as they share one Postgres.
// Given a clock, each window is a fixed minute of it, as Postgres's are of the database's clock;
// without one, a window never ends and always has 16.5 seconds left. The integration tests run the
// real statements on Postgres 18.
import { randomBytes } from "node:crypto";
import type { Clock } from "@fin/core";
import { createKeyring, type Keyring } from "@fin/crypto";
import {
  hashForStorage,
  type KeyKind,
  type KeyMode,
  type KeyRecord,
  type KeyStore,
  newKey,
  saltFor,
} from "@fin/keys";

export const SALT = saltFor("ci");
export const PEPPERS: Keyring = createKeyring(
  "API_KEY_PEPPER",
  new Map([[1, new Uint8Array(randomBytes(32))]]),
  1,
);
export const ORG = "org_01jd0000000000000000000000";

const MINUTE_MS = 60_000;

export class FakeStore implements KeyStore {
  readonly records = new Map<string, KeyRecord>();
  readonly windows = new Map<string, number>();
  readonly touched: string[] = [];
  statements = 0;
  liveKeysOn = false;
  failing = false;
  readonly #clock: Clock | undefined;
  /** The minute each window was last counted in, when the store keeps a clock. */
  readonly #minutes = new Map<string, number>();

  constructor(clock?: Clock) {
    this.#clock = clock;
  }

  /** Makes a key and its record; `over` changes the record as the view would return it. */
  add(mode: KeyMode, kind: KeyKind, over: Partial<KeyRecord> = {}, salt = SALT): string {
    const made = newKey(mode, kind, salt);
    const stored = hashForStorage(PEPPERS, made.body);
    this.records.set(made.id, {
      id: made.id,
      organization_id: ORG,
      mode,
      kind,
      scopes: kind === "sk" ? [] : ["customers:read", "events:read"],
      ip_allowlist: [],
      hash: Buffer.from(stored.hash),
      pepper_versions: stored.pepperVersions,
      expires_at: null,
      revoked_at: null,
      rolling_until: null,
      org_live_status: "not_enabled",
      ...over,
    });
    return made.key;
  }

  /** The window's count in the current minute (a window from an earlier minute reads as empty). */
  #current(windowKey: string): number {
    if (this.#clock !== undefined) {
      const minute = Math.floor(this.#clock.now() / MINUTE_MS);
      if (this.#minutes.get(windowKey) !== minute) {
        this.#minutes.set(windowKey, minute);
        this.windows.delete(windowKey);
      }
    }
    return this.windows.get(windowKey) ?? 0;
  }

  async lookup(keyId: string, refusedWindow: string) {
    this.statements += 1;
    if (this.failing) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    return {
      record: this.records.get(keyId) ?? null,
      refusedCount: this.#current(refusedWindow),
      liveKeysOn: this.liveKeysOn,
    };
  }

  async count(windowKey: string) {
    this.statements += 1;
    const count = this.#current(windowKey) + 1;
    this.windows.set(windowKey, count);
    const msLeft = this.#clock === undefined ? 16_500 : MINUTE_MS - (this.#clock.now() % MINUTE_MS);
    return { count, secondsLeft: Math.max(1, Math.ceil(msLeft / 1000)), msLeft };
  }

  async touch(keyId: string) {
    this.statements += 1;
    this.touched.push(keyId);
    return true;
  }
}
