// `LISTEN email_outbox` on one dedicated connection (ARCHITECTURE §4.5: the worker keeps one LISTEN
// connection outside its pool). `email.enqueue()` notifies at commit; the loop wakes at once instead
// of at the next poll. A lost connection is reopened after a pause; the poll covers the gap.
import type { EmailLog } from "@fin/email";
import type { Listen } from "./loop.ts";

export const CHANNEL = "email_outbox";

/** The slice of `pg.Client` the listener uses; the worker's main makes it from `@fin/db`'s settings. */
export interface ListenClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (message: { channel: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  end(): Promise<void>;
}

export interface ListenOptions {
  readonly connect: () => ListenClient;
  readonly log: EmailLog;
  readonly retryMs?: number;
}

export function pgListen(o: ListenOptions): Listen {
  return async (wake) => {
    let closed = false;
    let client: ListenClient | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const reopen = (reason: string): void => {
      if (closed || retry !== undefined) return;
      o.log.log("background.failed", { name: "email-listen", reason }, "warn");
      const old = client;
      client = undefined;
      void old?.end().catch(() => undefined);
      retry = setTimeout(() => {
        retry = undefined;
        void open().catch(() => reopen("connect"));
      }, o.retryMs ?? 5000);
      retry.unref();
    };

    const open = async (): Promise<void> => {
      const c = o.connect();
      c.on("notification", (message) => {
        if (message.channel === CHANNEL) wake();
      });
      let ready = false;
      c.on("error", () => {
        if (ready) reopen("error");
      });
      c.on("end", () => {
        if (ready) reopen("end");
      });
      try {
        await c.connect();
        await c.query(`LISTEN ${CHANNEL}`);
      } catch (error) {
        await c.end().catch(() => undefined);
        throw error;
      }
      ready = true;
      client = c;
      // Anything queued while the connection was down is picked up now.
      wake();
    };

    await open();
    return async () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      await client?.end().catch(() => undefined);
      client = undefined;
    };
  };
}
