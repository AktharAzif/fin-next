// The Worker's entry: a scheduled handler only (no fetch handler, so it serves no request), run by
// a `* * * * *` cron. No binding but its own settings and secrets, plain fetch, Web APIs only, so
// it moves to any scheduled runner outside Railway without a rewrite (OB-18).
import { runWatcher, type WatcherEnv } from "./run.ts";

/** The two members of Cloudflare's ExecutionContext this Worker uses. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  scheduled(_controller: unknown, env: WatcherEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runWatcher(env, {
        fetch: (input, init) => fetch(input, init),
        now: () => Date.now(),
        randomId: () => crypto.randomUUID(),
      }),
    );
  },
};
