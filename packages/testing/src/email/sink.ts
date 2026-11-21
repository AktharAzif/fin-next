// The email sink (ARCHITECTURE §11.4; spec 02 §19.3): where a `test` image's email adapter puts
// the messages it would have sent, so a journey can read its sign-in code or invitation link.
// Test target only ([SA-38]); a `release` image's adapter is Cloudflare only.
//
// It accepts only fixture recipients (example.com, example.org, example.net and their
// subdomains), so a misconfigured test can never believe it reached a real person. Messages stay
// in memory for the life of the process.
import { type Handler, type Listening, listen } from "@fin/server/testing/node-http";

export interface SinkMessageInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** Message headers the adapter set (List-Unsubscribe, Auto-Submitted, ...). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The template that rendered it, e.g. "identity/sign-in-code". */
  readonly template?: string;
  /** security, transactional or notice. */
  readonly category?: string;
}

export interface SinkMessage extends SinkMessageInput {
  readonly id: string;
  /** The order the sink received it in, from 1. */
  readonly sequence: number;
  readonly receivedAt: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface SinkFilter {
  /** A recipient, compared without case. */
  readonly to?: string;
  /** A substring of the subject. */
  readonly subject?: string;
  readonly template?: string;
  /** Only messages received after this sequence number. */
  readonly after?: number;
}

const FIXTURE_DOMAINS = ["example.com", "example.org", "example.net"];
const ADDRESS = /^[^\s@<>]+@([^\s@<>]+)$/;

/** True for an address on a fixture domain (RFC 2606's example domains and their subdomains). */
export function isFixtureAddress(address: string): boolean {
  const match = ADDRESS.exec(address.trim());
  if (match === null) return false;
  const domain = (match[1] as string).toLowerCase();
  return FIXTURE_DOMAINS.some((fixture) => domain === fixture || domain.endsWith(`.${fixture}`));
}

export class SinkRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SinkRefusal";
    this.code = code;
  }
}

function matches(message: SinkMessage, filter: SinkFilter): boolean {
  if (filter.after !== undefined && message.sequence <= filter.after) return false;
  if (filter.template !== undefined && message.template !== filter.template) return false;
  if (filter.subject !== undefined && !message.subject.includes(filter.subject)) return false;
  if (filter.to !== undefined) {
    const wanted = filter.to.toLowerCase();
    if (!message.to.some((to) => to.toLowerCase() === wanted)) return false;
  }
  return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/** Checks a message an adapter posted. Throws SinkRefusal naming what is wrong (never values). */
export function validateMessage(value: unknown): SinkMessageInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SinkRefusal("invalid_message", "a message is a JSON object");
  }
  const record = value as Record<string, unknown>;
  const { from, to, subject, text, html, headers, template, category } = record;
  if (typeof from !== "string" || from === "") throw new SinkRefusal("invalid_message", "from");
  if (!Array.isArray(to) || to.length === 0 || !to.every((t) => typeof t === "string")) {
    throw new SinkRefusal("invalid_message", "to is a non-empty list of addresses");
  }
  if (typeof subject !== "string") throw new SinkRefusal("invalid_message", "subject");
  if (typeof text !== "string") throw new SinkRefusal("invalid_message", "text");
  if (html !== undefined && typeof html !== "string")
    throw new SinkRefusal("invalid_message", "html");
  if (headers !== undefined && !isStringRecord(headers)) {
    throw new SinkRefusal("invalid_message", "headers is an object of strings");
  }
  if (template !== undefined && typeof template !== "string") {
    throw new SinkRefusal("invalid_message", "template");
  }
  if (category !== undefined && typeof category !== "string") {
    throw new SinkRefusal("invalid_message", "category");
  }
  if (!(to as string[]).every(isFixtureAddress)) {
    throw new SinkRefusal("recipient_not_fixture", "every recipient is on a fixture domain");
  }
  return {
    from,
    to: to as string[],
    subject,
    text,
    ...(html === undefined ? {} : { html }),
    ...(headers === undefined ? {} : { headers }),
    ...(template === undefined ? {} : { template }),
    ...(category === undefined ? {} : { category }),
  };
}

interface Waiter {
  readonly filter: SinkFilter;
  readonly resolve: (message: SinkMessage) => void;
}

export class EmailSink {
  readonly #messages: SinkMessage[] = [];
  #waiters: Waiter[] = [];
  readonly #now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Stores a message (validated) and wakes anyone waiting for one like it. */
  add(input: unknown): SinkMessage {
    const valid = validateMessage(input);
    const sequence = this.#messages.length + 1;
    const message: SinkMessage = {
      ...valid,
      headers: valid.headers ?? {},
      id: `msg_${String(sequence).padStart(6, "0")}`,
      sequence,
      receivedAt: new Date(this.#now()).toISOString(),
    };
    this.#messages.push(message);
    const still: Waiter[] = [];
    for (const waiter of this.#waiters) {
      if (matches(message, waiter.filter)) waiter.resolve(message);
      else still.push(waiter);
    }
    this.#waiters = still;
    return message;
  }

  list(filter: SinkFilter = {}): SinkMessage[] {
    return this.#messages.filter((message) => matches(message, filter));
  }

  /** The newest sequence number, for `after` in a later wait. */
  get last(): number {
    return this.#messages.length;
  }

  /** The first message matching `filter`, now or when it arrives; rejects after `timeoutMs`. */
  waitFor(filter: SinkFilter, timeoutMs = 10_000): Promise<SinkMessage> {
    const found = this.#messages.find((message) => matches(message, filter));
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        filter,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new SinkRefusal("timeout", "no matching message arrived in time"));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }
}

function filterFrom(params: URLSearchParams): SinkFilter {
  const after = params.get("after");
  return {
    ...(params.get("to") === null ? {} : { to: params.get("to") as string }),
    ...(params.get("subject") === null ? {} : { subject: params.get("subject") as string }),
    ...(params.get("template") === null ? {} : { template: params.get("template") as string }),
    ...(after === null || !/^\d+$/.test(after) ? {} : { after: Number(after) }),
  };
}

const MAX_BODY = 1024 * 1024;

async function readJson(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (body === null) return undefined;
  const text = await new Response(body).text();
  if (text.length > MAX_BODY) throw new SinkRefusal("too_large", "a message is at most 1 MiB");
  return JSON.parse(text);
}

/**
 * The sink's HTTP face:
 *   POST   /messages         an adapter delivers one message (201 with { id, sequence })
 *   GET    /messages?...     the messages matching to, subject, template and after
 *   GET    /messages/wait?…  the first match, waiting up to timeoutMs (default 10 s; 408 after)
 */
export function emailSinkHandler(sink: EmailSink): Handler {
  return async (request) => {
    const url = new URL(request.target, "http://sink.invalid");
    try {
      if (url.pathname === "/messages" && request.method === "POST") {
        const contentType = request.headers.find(([name]) => name.toLowerCase() === "content-type");
        if (contentType === undefined || !contentType[1].startsWith("application/json")) {
          throw new SinkRefusal("unsupported_media_type", "the body is JSON");
        }
        let parsed: unknown;
        try {
          parsed = await readJson(request.body);
        } catch (error) {
          if (error instanceof SinkRefusal) throw error;
          throw new SinkRefusal("invalid_message", "the body is not JSON");
        }
        const message = sink.add(parsed);
        return Response.json({ id: message.id, sequence: message.sequence }, { status: 201 });
      }
      if (url.pathname === "/messages" && request.method === "GET") {
        return Response.json({
          messages: sink.list(filterFrom(url.searchParams)),
          last: sink.last,
        });
      }
      if (url.pathname === "/messages/wait" && request.method === "GET") {
        const timeout = Number(url.searchParams.get("timeoutMs") ?? "10000");
        const timeoutMs = Number.isFinite(timeout)
          ? Math.min(Math.max(timeout, 0), 60_000)
          : 10_000;
        try {
          const message = await sink.waitFor(filterFrom(url.searchParams), timeoutMs);
          return Response.json({ message });
        } catch {
          return Response.json({ error: "timeout" }, { status: 408 });
        }
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      if (error instanceof SinkRefusal) {
        const status = error.code === "unsupported_media_type" ? 415 : 422;
        return Response.json({ error: error.code, detail: error.message }, { status });
      }
      throw error;
    }
  };
}

export interface RunningEmailSink extends Listening {
  readonly sink: EmailSink;
}

export async function startEmailSink(
  options: { readonly port?: number; readonly sink?: EmailSink } = {},
): Promise<RunningEmailSink> {
  const sink = options.sink ?? new EmailSink();
  const listening = await listen(emailSinkHandler(sink), {
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  return { ...listening, sink };
}
