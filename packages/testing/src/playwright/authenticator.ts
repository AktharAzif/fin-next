// The virtual authenticator (spec 02 §19.3): Playwright's WebAuthn credentials on a browser
// context. Once installed it answers the page's `navigator.credentials.create()` and `.get()`;
// a test can seed a passkey the server already knows, read back the one the page registered (with
// its private key, to reuse in a later context), or remove one to show a lost device.
import type { BrowserContext } from "@playwright/test";

export interface VirtualCredential {
  readonly id: string;
  readonly rpId: string;
  readonly userHandle: string;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly signCount: number;
}

export interface VirtualAuthenticator {
  /** The relying party ID for an app origin: its host name (the passkey `rpID`, spec 02). */
  rpIdFor(origin: string): string;
  /** Seeds a new discoverable passkey (or imports a known one) and returns it. */
  seed(rpId: string, known?: Partial<Omit<VirtualCredential, "rpId">>): Promise<VirtualCredential>;
  /** Every credential the authenticator holds, optionally for one relying party. */
  list(rpId?: string): Promise<VirtualCredential[]>;
  /** The one credential for a relying party; throws when there is none or more than one. */
  only(rpId: string): Promise<VirtualCredential>;
  remove(id: string): Promise<void>;
}

export function rpIdFor(origin: string): string {
  return new URL(origin).hostname;
}

/** Installs the authenticator on a context. Call before a page touches navigator.credentials. */
export async function installAuthenticator(context: BrowserContext): Promise<VirtualAuthenticator> {
  const credentials = context.credentials;
  await credentials.install();
  const list = async (rpId?: string) =>
    credentials.get(rpId === undefined ? {} : { rpId }) as Promise<VirtualCredential[]>;
  return {
    rpIdFor,
    async seed(rpId, known = {}) {
      const options: Record<string, string | number> = {};
      for (const key of ["id", "userHandle", "privateKey", "publicKey", "signCount"] as const) {
        const value = known[key];
        if (value !== undefined) options[key] = value;
      }
      return (await credentials.create(rpId, options)) as VirtualCredential;
    },
    list,
    async only(rpId) {
      const found = await list(rpId);
      if (found.length !== 1) {
        throw new Error(`expected one passkey for ${rpId}, found ${found.length}`);
      }
      return found[0] as VirtualCredential;
    },
    remove: (id) => credentials.delete(id),
  };
}
