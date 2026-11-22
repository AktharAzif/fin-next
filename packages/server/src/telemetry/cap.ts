// The 8 KB cap on one line (ARCHITECTURE §10.2; spec 08 §7.3): longer string values are cut and the
// line is marked `truncated: true`. Lengths are UTF-8 bytes of the serialised line.
import { ENVELOPE_KEYS } from "./lines.ts";

export const MAX_LINE_BYTES = 8 * 1024;

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function cutStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…` : value;
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, limit));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cutStrings(item, limit);
    return out;
  }
  return value;
}

/** Serialises a line, cutting it to at most 8 KB. */
export function capLine(line: Record<string, unknown>): string {
  const whole = JSON.stringify(line);
  if (byteLength(whole) <= MAX_LINE_BYTES) return whole;
  for (let limit = 2048; limit >= 16; limit = Math.floor(limit / 2)) {
    const cut: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(line)) {
      cut[key] = ENVELOPE_KEYS.has(key) ? item : cutStrings(item, limit);
    }
    cut.truncated = true;
    const text = JSON.stringify(cut);
    if (byteLength(text) <= MAX_LINE_BYTES) return text;
  }
  // Too many fields even with every string cut: keep the envelope alone.
  const envelope: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(line)) if (ENVELOPE_KEYS.has(key)) envelope[key] = item;
  envelope.truncated = true;
  return JSON.stringify(envelope);
}
