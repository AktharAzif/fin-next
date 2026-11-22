// SCRAM-SHA-256 verifiers (RFC 5802, RFC 7677) in Postgres's stored form,
// `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (standard base64). Postgres accepts a
// verifier as a role's password and never sees the plaintext, so the bootstrap and the per-run owner
// password hand the database only this (spec 01 §6.6 step 3). `parseScramVerifier` is how
// `migrate --bootstrap` refuses anything that is not a verifier, a plaintext password above all.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const SCRAM_ITERATIONS = 4096;
const SALT_BYTES = 16;
const VERIFIER =
  /^SCRAM-SHA-256\$([1-9][0-9]{3,6}):([A-Za-z0-9+/]{16,}={0,2})\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/;

export interface ScramVerifier {
  iterations: number;
  salt: Uint8Array;
  storedKey: Uint8Array;
  serverKey: Uint8Array;
}

export class ScramVerifierError extends Error {
  override readonly name = "ScramVerifierError";
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export interface ScramKeys {
  clientKey: Uint8Array;
  storedKey: Uint8Array;
  serverKey: Uint8Array;
}

/** The SCRAM keys of a password; exported for the RFC 7677 known-answer test. */
export function scramKeys(password: string, salt: Uint8Array, iterations: number): ScramKeys {
  // Postgres applies SASLprep; Fin's generated passwords are base64url, which SASLprep leaves as is.
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new ScramVerifierError("generated passwords are printable ASCII only");
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = new Uint8Array(createHmac("sha256", salted).update("Client Key").digest());
  return {
    clientKey,
    storedKey: new Uint8Array(createHash("sha256").update(clientKey).digest()),
    serverKey: new Uint8Array(createHmac("sha256", salted).update("Server Key").digest()),
  };
}

export interface VerifierOptions {
  iterations?: number;
  /** Tests inject a fixed salt for known answers. */
  salt?: Uint8Array;
}

export function scramSha256Verifier(password: string, options: VerifierOptions = {}): string {
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 4096 || iterations > 1_000_000) {
    throw new ScramVerifierError("iterations out of bounds");
  }
  const salt = options.salt ?? new Uint8Array(randomBytes(SALT_BYTES));
  const { storedKey, serverKey } = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

export function parseScramVerifier(text: string): ScramVerifier {
  const match = VERIFIER.exec(text);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new ScramVerifierError("not a SCRAM-SHA-256 verifier");
  }
  const salt = new Uint8Array(Buffer.from(match[2], "base64"));
  if (salt.byteLength < 8 || b64(salt) !== match[2]) {
    throw new ScramVerifierError("not a SCRAM-SHA-256 verifier");
  }
  return {
    iterations: Number(match[1]),
    salt,
    storedKey: new Uint8Array(Buffer.from(match[3], "base64")),
    serverKey: new Uint8Array(Buffer.from(match[4] ?? "", "base64")),
  };
}

export function isScramVerifier(text: string): boolean {
  try {
    parseScramVerifier(text);
    return true;
  } catch {
    return false;
  }
}

/** A fresh password for a database login: 32 random bytes, base64url (spec 08 §6.2, `db-login`). */
export function generateDatabasePassword(): string {
  return randomBytes(32).toString("base64url");
}
