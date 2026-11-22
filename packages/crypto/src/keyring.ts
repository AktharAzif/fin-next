// Versioned key families (spec 08 §6.1, ARCHITECTURE §6.6). A family `<FAMILY>` keeps its versions
// in `<FAMILY>_<n>` and names the one writers use in `<FAMILY>_IN_USE`; index families also name
// the versions written beside it in `<FAMILY>_WRITE`. Readers accept every version present, at most
// three are present at once, and an `IN_USE` naming an absent version refuses to boot (exit 78 in
// the caller). Errors name the variable, never its value.
import { fromBase64Url } from "./bytes.ts";

export const KEY_BYTES = 32;
export const MAX_VERSIONS = 3;

export type KeyFamily =
  | "FIN_SEAL_KEY"
  | "FIN_INDEX_KEY"
  | "FIN_MONEY_SEAL_KEY"
  | "FIN_MONEY_INDEX_KEY"
  | "FIN_LIMIT_KEY"
  | "FIN_CURSOR_KEY"
  | "API_KEY_PEPPER";

const WRITE_FAMILIES: ReadonlySet<KeyFamily> = new Set(["FIN_INDEX_KEY", "FIN_MONEY_INDEX_KEY"]);

export class KeyringConfigError extends Error {
  override readonly name = "KeyringConfigError";
  readonly variable: string;
  constructor(variable: string, problem: string) {
    super(`${variable}: ${problem}`);
    this.variable = variable;
  }
}

export interface Keyring {
  readonly family: KeyFamily;
  /** The version writers use. */
  readonly inUse: number;
  /** Every version present, ascending. */
  readonly versions: readonly number[];
  /** The versions an index family writes (always including `inUse`); `[inUse]` for others. */
  readonly writeVersions: readonly number[];
  /** The key of a version, or undefined when that version is not present. */
  key(version: number): Uint8Array | undefined;
}

function parseVersion(text: string, variable: string): number {
  if (!/^[1-9][0-9]{0,5}$/.test(text)) {
    throw new KeyringConfigError(variable, "must be a positive integer version");
  }
  return Number(text);
}

/** Builds a keyring from explicit versions (tests, tasks). Keys are copied. */
export function createKeyring(
  family: KeyFamily,
  keys: ReadonlyMap<number, Uint8Array>,
  inUse: number,
  writeVersions?: readonly number[],
): Keyring {
  if (keys.size === 0) throw new KeyringConfigError(`${family}_<n>`, "no version is present");
  if (keys.size > MAX_VERSIONS) {
    throw new KeyringConfigError(
      `${family}_<n>`,
      `at most ${MAX_VERSIONS} versions may be present`,
    );
  }
  const copies = new Map<number, Uint8Array>();
  for (const [version, key] of keys) {
    if (!Number.isInteger(version) || version < 1) {
      throw new KeyringConfigError(`${family}_${version}`, "versions are positive integers");
    }
    if (key.byteLength !== KEY_BYTES) {
      throw new KeyringConfigError(`${family}_${version}`, `must be ${KEY_BYTES} bytes`);
    }
    copies.set(version, new Uint8Array(key));
  }
  if (!copies.has(inUse)) {
    throw new KeyringConfigError(`${family}_IN_USE`, "names a version that is not present");
  }
  const write = writeVersions ?? [inUse];
  if (!write.includes(inUse)) {
    throw new KeyringConfigError(`${family}_WRITE`, "must include the IN_USE version");
  }
  for (const version of write) {
    if (!copies.has(version)) {
      throw new KeyringConfigError(`${family}_WRITE`, "names a version that is not present");
    }
  }
  const versions = [...copies.keys()].sort((a, b) => a - b);
  return {
    family,
    inUse,
    versions,
    writeVersions: [...new Set(write)].sort((a, b) => a - b),
    key: (version) => copies.get(version),
  };
}

/** Reads a family from the process environment (called once, from `main()`). */
export function keyringFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  family: KeyFamily,
): Keyring {
  const pattern = new RegExp(`^${family}_([1-9][0-9]{0,5})$`);
  const keys = new Map<number, Uint8Array>();
  for (const [name, value] of Object.entries(env)) {
    const match = pattern.exec(name);
    if (match?.[1] === undefined || value === undefined) continue;
    let key: Uint8Array;
    try {
      key = fromBase64Url(value.trim());
    } catch {
      throw new KeyringConfigError(name, "must be base64url");
    }
    if (key.byteLength !== KEY_BYTES) {
      throw new KeyringConfigError(name, `must decode to ${KEY_BYTES} bytes`);
    }
    keys.set(Number(match[1]), key);
  }
  const inUseVariable = `${family}_IN_USE`;
  const inUseText = env[inUseVariable];
  if (inUseText === undefined || inUseText === "") {
    throw new KeyringConfigError(inUseVariable, "is required");
  }
  const inUse = parseVersion(inUseText.trim(), inUseVariable);
  let write: number[] | undefined;
  const writeVariable = `${family}_WRITE`;
  const writeText = env[writeVariable];
  if (writeText !== undefined && writeText !== "") {
    if (!WRITE_FAMILIES.has(family)) {
      throw new KeyringConfigError(writeVariable, "is not a setting of this family");
    }
    write = writeText.split(",").map((part) => parseVersion(part.trim(), writeVariable));
  }
  return createKeyring(family, keys, inUse, write);
}
