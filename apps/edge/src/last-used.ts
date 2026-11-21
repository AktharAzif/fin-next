// "Last used" ([BC-05]; spec 05 §2.1 step 23, §4.6): after the answer, `keys.touch_last_used()` runs at
// most once a minute per key, so a busy key costs the edge's small pool ([SA-19]: 8 clients a
// replica) one statement a minute, not one a request. The function's own WHERE writes at most once a
// minute per key across replicas; this map only spares the statement on this one. It lives in
// process memory, bounded like the shedder's maps (the oldest key goes first), and decides nothing
// about a person: a replica that forgets a key touches it once more, which the function ignores.
import type { Clock } from "@fin/core";

const MINUTE_MS = 60_000;

export class LastUsed {
  readonly #clock: Clock;
  readonly #maxEntries: number;
  /** Key ID to the minute (since the epoch, by this replica's clock) it was last touched in. */
  readonly #touched = new Map<string, number>();

  constructor(clock: Clock, maxEntries: number) {
    this.#clock = clock;
    this.#maxEntries = Math.max(1, maxEntries);
  }

  /** Whether "last used" is due for this key: true at most once a minute per key, then remembered. */
  due(keyId: string): boolean {
    const minute = Math.floor(this.#clock.now() / MINUTE_MS);
    if (this.#touched.get(keyId) === minute) return false;
    this.#touched.delete(keyId);
    if (this.#touched.size >= this.#maxEntries) {
      const oldest = this.#touched.keys().next().value;
      if (oldest !== undefined) this.#touched.delete(oldest);
    }
    this.#touched.set(keyId, minute);
    return true;
  }

  /** How many keys are remembered (for tests). */
  get size(): number {
    return this.#touched.size;
  }
}
