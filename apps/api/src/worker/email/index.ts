// The worker's email side, put together (ARCHITECTURE §9.4; [EM-04]: only the worker holds the email
// token and sends). The worker's `main()` (P0-D) reads the environment once, makes the pool and the
// telemetry, and calls `startEmailWorker`; nothing here runs at import.
import {
  CloudflareEmailAdapter,
  type EmailLog,
  type EmailPort,
  type PoolLike,
  recipientHasher,
  Sender,
  type SenderLimits,
} from "@fin/email";
import type { EmailWorkerConfig } from "./config.ts";
import { onDeliveryCheckSent, runDeliveryCheck } from "./delivery-check.ts";
import { type ListenClient, pgListen } from "./listen.ts";
import { EmailLoop, type Scheduler } from "./loop.ts";

export { EmailConfigError, type EmailWorkerConfig, readEmailConfig } from "./config.ts";
export { DUTY as DELIVERY_CHECK_DUTY, pingHeartbeat, runDeliveryCheck } from "./delivery-check.ts";
export { EmailLoop, JOB as EMAIL_SEND_JOB } from "./loop.ts";

export interface EmailWorkerDeps {
  readonly pool: PoolLike;
  readonly log: EmailLog;
  readonly clock: { now(): number };
  /** The replica's name, for the lease holder (with a per-process nonce added here). */
  readonly replica: string;
  /** Makes the dedicated LISTEN connection; without it the 5-second poll alone wakes the loop. */
  readonly listenClient?: () => ListenClient;
  /** Tests replace the transport; the release image always uses Cloudflare's. */
  readonly port?: EmailPort;
  readonly fetch?: typeof fetch;
  readonly limits?: Partial<SenderLimits>;
  readonly schedule?: Scheduler;
}

export interface EmailWorker {
  readonly loop: EmailLoop;
  readonly sender: Sender;
  stop(): Promise<void>;
}

export async function startEmailWorker(
  config: EmailWorkerConfig,
  deps: EmailWorkerDeps,
): Promise<EmailWorker> {
  const port =
    deps.port ??
    new CloudflareEmailAdapter({
      accountId: config.accountId,
      token: config.token,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      clock: deps.clock,
      // One `provider.call` line per try (ARCHITECTURE §10.2), into the worker's telemetry.
      log: deps.log,
    });
  const heartbeat = {
    url: config.heartbeatUrl,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  };
  const sender = new Sender({
    db: deps.pool,
    port,
    clock: deps.clock,
    log: deps.log,
    holder: `${deps.replica}:${crypto.randomUUID().slice(0, 8)}`,
    environment: config.environment,
    from: {
      auth: { address: config.authFrom, name: "Fin" },
      ...(config.notifyFrom === undefined
        ? {}
        : { notify: { address: config.notifyFrom, name: "Fin" } }),
    },
    links: config.links,
    hashRecipient: recipientHasher(config.limitKey),
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    onSent: onDeliveryCheckSent(deps.log, heartbeat),
  });
  const loop = new EmailLoop({
    sender,
    log: deps.log,
    clock: deps.clock,
    ...(deps.listenClient === undefined
      ? {}
      : { listen: pgListen({ connect: deps.listenClient, log: deps.log }) }),
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
    deliveryCheck: () =>
      runDeliveryCheck({
        db: deps.pool,
        clock: deps.clock,
        release: config.release,
        seedInbox: config.seedInbox,
        log: deps.log,
      }),
  });
  await loop.start();
  return { loop, sender, stop: () => loop.stop() };
}
