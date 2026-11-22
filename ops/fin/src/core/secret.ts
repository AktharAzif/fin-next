// Values that must never be printed. A Secret (a token, a tunnel token, an ingress proof) prints as
// "[redacted]" through every path Node offers (string conversion, JSON, util.inspect), so an
// accidental log line or error message carries nothing; a PrivateNumber (a threshold) prints its
// role placeholder the same way. Only reveal() gives the value, and only the code that sends it to
// its one destination calls it.

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

/**
 * A private number ([OB-13]: an alert threshold, a grace period): it prints its role placeholder
 * (`<threshold:api-v4>`) through every path Node offers, string conversion and arithmetic included
 * (`${n}`, `n + 1` and JSON give the placeholder; Number(n) is NaN), so it never reaches output and
 * never needs masking by value, which a short number cannot get safely (core/mask.ts). Only
 * reveal() gives the number, for the one request body that carries it.
 */
export class PrivateNumber {
  readonly #value: number;
  readonly placeholder: string;

  constructor(value: number, placeholder: string) {
    this.#value = value;
    this.placeholder = placeholder;
  }

  /** The number itself, for the one request that sends it. */
  reveal(): number {
    return this.#value;
  }

  [Symbol.toPrimitive](): string {
    return this.placeholder;
  }

  toString(): string {
    return this.placeholder;
  }

  toJSON(): string {
    return this.placeholder;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.placeholder;
  }
}
