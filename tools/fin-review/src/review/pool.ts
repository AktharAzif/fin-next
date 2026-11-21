// Bounded concurrency (spec 07 §4.9, §5.5): at most `limit` sessions at once, sceptics included,
// first come first served. Only a session holds a slot; the code that waits for sessions does not,
// so a sceptic queued by a running lens never deadlocks the pool.

export class Pool {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("a pool limit must be a positive integer");
    this.limit = limit;
  }

  /** The number of tasks running now. */
  get running(): number {
    return this.active;
  }

  /** Runs `task` when a slot is free and resolves with its result. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    // A finished task hands its slot straight to the next waiter, so a caller arriving in between
    // can never push the count past the limit.
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.active--;
    }
  }
}
