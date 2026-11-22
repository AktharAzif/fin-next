// The Better Stack transport (ARCHITECTURE §10.3; spec 08 §7.3; [OB-03]): Better Stack's native JSON
// array, gzip-encoded, with the source's bearer token, a 3-second timeout, one retry on a network
// error, 429 or 5xx, and never a retry on any other 4xx.
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);

/** Sends one gzip body and answers the HTTP status; throws on a network error or timeout. */
export type Transport = (body: Uint8Array, signal: AbortSignal) => Promise<number>;

export const SEND_TIMEOUT_MS = 3000;
export const MAX_BATCH_BYTES = 256 * 1024;

/** POSTs to `https://<FIN_TELEMETRY_HOST>/` (spec 08 §7.3). */
export function betterStackTransport(options: {
  host: string;
  token: string;
  fetch?: typeof fetch;
}): Transport {
  const send = options.fetch ?? fetch;
  const url = `https://${options.host}/`;
  return async (body, signal) => {
    const response = await send(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body,
      signal,
      redirect: "error",
    });
    await response.body?.cancel();
    return response.status;
  };
}

export async function gzipLines(lines: readonly string[]): Promise<Uint8Array> {
  return new Uint8Array(await gzip(`[${lines.join(",")}]`));
}

/** Splits serialised lines into batches of at most 256 KB before gzip. */
export function batches(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 2;
  for (const line of lines) {
    const length = Buffer.byteLength(line) + 1;
    if (current.length > 0 && size + length > MAX_BATCH_BYTES) {
      out.push(current);
      current = [];
      size = 2;
    }
    current.push(line);
    size += length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export type SendResult = { ok: true } | { ok: false; status: number };

function retryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** Sends one body, retrying once where the rules allow. Status 0 stands for a network failure. */
export async function sendWithRetry(
  transport: Transport,
  body: Uint8Array,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendResult> {
  let status = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      status = await transport(body, AbortSignal.timeout(timeoutMs));
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) return { ok: true };
    if (!retryable(status)) break;
  }
  return { ok: false, status };
}
