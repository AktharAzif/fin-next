// Reads the email sink from a test: wait for a message, then take its code or its links.
import type { SinkFilter, SinkMessage } from "./sink.ts";

export interface WaitOptions {
  /** Default 10 s. */
  readonly timeoutMs?: number;
}

function query(filter: SinkFilter, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (filter.to !== undefined) params.set("to", filter.to);
  if (filter.subject !== undefined) params.set("subject", filter.subject);
  if (filter.template !== undefined) params.set("template", filter.template);
  if (filter.after !== undefined) params.set("after", String(filter.after));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export class EmailSinkReader {
  readonly origin: string;

  constructor(origin: string) {
    this.origin = origin.replace(/\/+$/, "");
  }

  async list(filter: SinkFilter = {}): Promise<{ messages: SinkMessage[]; last: number }> {
    const response = await fetch(`${this.origin}/messages${query(filter)}`);
    if (!response.ok) throw new Error(`the email sink answered ${response.status}`);
    return (await response.json()) as { messages: SinkMessage[]; last: number };
  }

  /** The newest sequence number; pass it as `after` to wait only for what comes next. */
  async mark(): Promise<number> {
    return (await this.list({ after: Number.MAX_SAFE_INTEGER })).last;
  }

  /** The first message matching `filter`, waiting for it to arrive. */
  async waitFor(filter: SinkFilter, options: WaitOptions = {}): Promise<SinkMessage> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const response = await fetch(
      `${this.origin}/messages/wait${query(filter, { timeoutMs: String(timeoutMs) })}`,
    );
    if (response.status === 408) {
      throw new Error(`no email matching the filter arrived within ${timeoutMs} ms`);
    }
    if (!response.ok) throw new Error(`the email sink answered ${response.status}`);
    return ((await response.json()) as { message: SinkMessage }).message;
  }

  /** Waits for a message and returns its code (see `codeFrom`). */
  async waitForCode(
    filter: SinkFilter,
    options: WaitOptions & { readonly pattern?: RegExp } = {},
  ): Promise<string> {
    return codeFrom(await this.waitFor(filter, options), options.pattern);
  }
}

/** Six digits standing alone, unless the caller's pattern (with one capture group) says otherwise. */
const DEFAULT_CODE = /(?<![\w-])(\d{6})(?![\w-])/;

/**
 * The one code in a message's text. Throws when there is none, or when the text holds two
 * different ones (a template that shows two codes is a bug a journey should catch).
 */
export function codeFrom(
  message: Pick<SinkMessage, "text">,
  pattern: RegExp = DEFAULT_CODE,
): string {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const found = new Set<string>();
  for (const match of message.text.matchAll(global)) found.add(match[1] ?? match[0]);
  if (found.size === 0) throw new Error("the message holds no code");
  if (found.size > 1) throw new Error("the message holds more than one code");
  return [...found][0] as string;
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/** Every distinct http(s) link in a message, from its text and its HTML hrefs, in order. */
export function linksFrom(message: Pick<SinkMessage, "text" | "html">): string[] {
  const links: string[] = [];
  const add = (link: string) => {
    const trimmed = link.replace(/[).,;:!?'"]+$/, "");
    if (!links.includes(trimmed)) links.push(trimmed);
  };
  for (const match of message.text.matchAll(/https?:\/\/[^\s<>"]+/g)) add(match[0]);
  for (const match of (message.html ?? "").matchAll(/href\s*=\s*"(https?:\/\/[^"]+)"/gi)) {
    add(decodeEntities(match[1] as string));
  }
  return links;
}
