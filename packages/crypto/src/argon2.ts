// Password hashing with argon2id through Node's built-in `crypto.argon2` (DECISIONS SA-07; Node 26
// provides it, so no native dependency). Hashes are PHC strings,
// `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>` in unpadded base64, so the cost can rise
// later: `needsRehash` says when a stored hash is below the current parameters. Verification parses
// strictly and bounds every parameter, so a stored string cannot ask for an unbounded amount of work.
import { argon2, randomBytes } from "node:crypto";
import { fromBase64NoPad, toBase64NoPad, utf8 } from "./bytes.ts";
import { constantTimeEqualBytes } from "./compare.ts";

export interface Argon2Params {
  /** Memory in KiB. */
  memoryKiB: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

/** OWASP's minimum argon2id profile (SA-07): m = 19,456 KiB, t = 2, p = 1, a 32-byte tag. */
export const ARGON2ID_DEFAULTS: Readonly<Argon2Params> = Object.freeze({
  memoryKiB: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
});

const SALT_BYTES = 16;
const MAX_PASSWORD_BYTES = 1024;
const LIMITS = {
  memoryKiB: { min: 8, max: 262_144 },
  passes: { min: 1, max: 10 },
  parallelism: { min: 1, max: 16 },
  tagLength: { min: 16, max: 64 },
} as const;
const PHC =
  /^\$argon2id\$v=19\$m=([1-9][0-9]{0,6}),t=([1-9][0-9]?),p=([1-9][0-9]?)\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{22,})$/;

export class PasswordHashError extends Error {
  override readonly name = "PasswordHashError";
}

export interface Argon2Input extends Argon2Params {
  message: Uint8Array;
  nonce: Uint8Array;
  secret?: Uint8Array;
  associatedData?: Uint8Array;
}

/** The raw argon2id tag; exported for the RFC 9106 known-answer test. */
export function argon2idRaw(input: Argon2Input): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: input.message,
        nonce: input.nonce,
        memory: input.memoryKiB,
        passes: input.passes,
        parallelism: input.parallelism,
        tagLength: input.tagLength,
        ...(input.secret === undefined ? {} : { secret: input.secret }),
        ...(input.associatedData === undefined ? {} : { associatedData: input.associatedData }),
      },
      (error, tag) => {
        if (error) reject(error);
        else resolve(new Uint8Array(tag));
      },
    );
  });
}

function checkParams(params: Argon2Params): void {
  for (const name of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const value = params[name];
    const { min, max } = LIMITS[name];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new PasswordHashError(`argon2id ${name} out of bounds`);
    }
  }
  if (params.memoryKiB < 8 * params.parallelism) {
    throw new PasswordHashError("argon2id memory must be at least 8 KiB per lane");
  }
}

function passwordBytes(password: string): Uint8Array {
  const bytes = utf8(password.normalize("NFC"));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PASSWORD_BYTES) {
    throw new PasswordHashError("password length out of bounds");
  }
  return bytes;
}

export interface ParsedHash extends Argon2Params {
  salt: Uint8Array;
  tag: Uint8Array;
}

export function parsePasswordHash(phc: string): ParsedHash {
  const match = PHC.exec(phc);
  if (match === null) throw new PasswordHashError("not an argon2id PHC string");
  const [, m, t, p, saltText, tagText] = match;
  let salt: Uint8Array;
  let tag: Uint8Array;
  try {
    salt = fromBase64NoPad(saltText ?? "");
    tag = fromBase64NoPad(tagText ?? "");
  } catch {
    throw new PasswordHashError("not an argon2id PHC string");
  }
  const parsed = {
    memoryKiB: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: tag.byteLength,
    salt,
    tag,
  };
  checkParams(parsed);
  if (salt.byteLength < 8 || salt.byteLength > 64) throw new PasswordHashError("salt length");
  return parsed;
}

export function formatPasswordHash(
  params: Argon2Params,
  salt: Uint8Array,
  tag: Uint8Array,
): string {
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}$${toBase64NoPad(salt)}$${toBase64NoPad(tag)}`;
}

export interface HashOptions {
  params?: Argon2Params;
  /** Tests inject a fixed salt for known answers. */
  salt?: Uint8Array;
}

export async function hashPassword(password: string, options: HashOptions = {}): Promise<string> {
  const params = options.params ?? ARGON2ID_DEFAULTS;
  checkParams(params);
  const salt = options.salt ?? new Uint8Array(randomBytes(SALT_BYTES));
  const tag = await argon2idRaw({ ...params, message: passwordBytes(password), nonce: salt });
  return formatPasswordHash(params, salt, tag);
}

/** True when the password matches; false for a mismatch or a malformed stored hash. */
export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  let parsed: ParsedHash;
  let message: Uint8Array;
  try {
    parsed = parsePasswordHash(phc);
    message = passwordBytes(password);
  } catch {
    return false;
  }
  const tag = await argon2idRaw({ ...parsed, message, nonce: parsed.salt });
  return constantTimeEqualBytes(tag, parsed.tag);
}

/** True when a stored hash is weaker than `params` and should be replaced at the next sign-in. */
export function needsRehash(phc: string, params: Argon2Params = ARGON2ID_DEFAULTS): boolean {
  let parsed: ParsedHash;
  try {
    parsed = parsePasswordHash(phc);
  } catch {
    return true;
  }
  return (
    parsed.memoryKiB < params.memoryKiB ||
    parsed.passes < params.passes ||
    parsed.parallelism !== params.parallelism ||
    parsed.tagLength < params.tagLength
  );
}
