// A value that must never be printed: a token, a tunnel token, an ingress proof. It prints as
// "[redacted]" through every path Node offers (string conversion, JSON, util.inspect), so an
// accidental log line or error message carries nothing. Only reveal() gives the value, and only
// the code that sends it to its one destination calls it.

const REDACTED = "[redacted]";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The value itself, for the one request that sends it. */
  reveal(): string {
    return this.#value;
  }

  /** Constant-time equality with another secret, without revealing either. */
  equals(other: Secret): boolean {
    const a = Buffer.from(this.#value);
    const b = Buffer.from(other.reveal());
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}
