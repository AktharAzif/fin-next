// The worker's email settings (spec 01 §6.7; ARCHITECTURE §3.5). Read once from the environment in
// `main()`, never at module scope; a missing or malformed value is reported by its variable's name,
// never its value, and the worker exits 78 (the caller's job).
import { z } from "zod";

export interface EmailWorkerConfig {
  readonly environment: string;
  readonly release: string;
  readonly token: string;
  readonly accountId: string;
  /** `account-security@auth.<zone>`: codes, security notices and the delivery check. */
  readonly authFrom: string;
  /** `<name>@notify.<zone>`: invitations and customer mail; absent until set. */
  readonly notifyFrom: string | undefined;
  readonly links: { readonly console?: string; readonly admin?: string; readonly verify?: string };
  readonly seedInbox: string;
  readonly limitKey: { readonly version: number; readonly secret: Uint8Array };
  /** Pinged after each delivery-check email is sent (spec 01 §8.5). */
  readonly heartbeatUrl: string | undefined;
}

export class EmailConfigError extends Error {
  readonly variables: readonly string[];
  constructor(variables: readonly string[]) {
    super(`email settings missing or malformed: ${variables.join(", ")}`);
    this.name = "EmailConfigError";
    this.variables = variables;
  }
}

const ADDRESS = /^[^\s@<>"]{1,64}@[a-z0-9.-]{3,253}$/u;
const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{2,5})?$/u;

function senderOn(subdomain: "auth" | "notify") {
  return z
    .string()
    .regex(ADDRESS)
    .refine((v) => (v.split("@")[1] ?? "").startsWith(`${subdomain}.`), {
      message: `the sender must be on the ${subdomain} sending subdomain`,
    });
}

const LINKS = z.strictObject({
  console: z.string().regex(ORIGIN).optional(),
  admin: z.string().regex(ORIGIN).optional(),
  verify: z.string().regex(ORIGIN).optional(),
});

const SCHEMA = {
  FIN_ENVIRONMENT: z.enum(["development", "ci", "staging", "production"]),
  FIN_RELEASE: z.string().regex(/^[0-9a-f]{40}$/u),
  FIN_EMAIL_TOKEN: z.string().min(20).regex(/^\S+$/u),
  FIN_EMAIL_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/u),
  FIN_EMAIL_FROM: senderOn("auth"),
  FIN_EMAIL_NOTIFY_FROM: senderOn("notify").optional(),
  FIN_EMAIL_LINK_ORIGINS: z.string(),
  FIN_SEED_INBOX: z.string().regex(ADDRESS),
  FIN_LIMIT_KEY_IN_USE: z.string().regex(/^[1-9]\d{0,3}$/u),
  FIN_HEARTBEAT_EMAIL_DELIVERY_CHECK_URL: z
    .string()
    .regex(/^https:\/\/\S+$/u)
    .optional(),
} as const;

type Env = Readonly<Record<string, string | undefined>>;

function decodeKey(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{43,}={0,2}$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength >= 32 ? new Uint8Array(bytes) : undefined;
}

/** Reads and checks every email variable; throws EmailConfigError naming all the bad ones. */
export function readEmailConfig(env: Env): EmailWorkerConfig {
  const bad: string[] = [];
  const read = <K extends keyof typeof SCHEMA>(
    name: K,
  ): z.output<(typeof SCHEMA)[K]> | undefined => {
    const raw = env[name];
    const parsed = SCHEMA[name].safeParse(raw === "" ? undefined : raw);
    if (!parsed.success) {
      bad.push(name);
      return undefined;
    }
    return parsed.data as z.output<(typeof SCHEMA)[K]>;
  };

  const environment = read("FIN_ENVIRONMENT");
  const release = read("FIN_RELEASE");
  const token = read("FIN_EMAIL_TOKEN");
  const accountId = read("FIN_EMAIL_ACCOUNT_ID");
  const authFrom = read("FIN_EMAIL_FROM");
  const notifyFrom = read("FIN_EMAIL_NOTIFY_FROM");
  const linksRaw = read("FIN_EMAIL_LINK_ORIGINS");
  const seedInbox = read("FIN_SEED_INBOX");
  const inUse = read("FIN_LIMIT_KEY_IN_USE");
  const heartbeatUrl = read("FIN_HEARTBEAT_EMAIL_DELIVERY_CHECK_URL");

  let links: EmailWorkerConfig["links"] | undefined;
  if (linksRaw !== undefined) {
    try {
      const parsed = LINKS.safeParse(JSON.parse(linksRaw));
      if (parsed.success) {
        // Only the roles that are set, so an absent role stays absent (no `undefined` values).
        links = Object.fromEntries(
          Object.entries(parsed.data).filter(([, origin]) => origin !== undefined),
        ) as EmailWorkerConfig["links"];
      } else bad.push("FIN_EMAIL_LINK_ORIGINS");
    } catch {
      bad.push("FIN_EMAIL_LINK_ORIGINS");
    }
  }

  let limitKey: EmailWorkerConfig["limitKey"] | undefined;
  if (inUse !== undefined) {
    const name = `FIN_LIMIT_KEY_${inUse}`;
    const secret = decodeKey(env[name] ?? "");
    if (secret === undefined) bad.push(name);
    else limitKey = { version: Number(inUse), secret };
  }

  if (
    bad.length > 0 ||
    environment === undefined ||
    release === undefined ||
    token === undefined ||
    accountId === undefined ||
    authFrom === undefined ||
    links === undefined ||
    seedInbox === undefined ||
    limitKey === undefined
  ) {
    throw new EmailConfigError(bad.length > 0 ? bad : ["(email settings)"]);
  }
  return {
    environment,
    release,
    token,
    accountId,
    authFrom,
    notifyFrom,
    links,
    seedInbox,
    limitKey,
    heartbeatUrl,
  };
}
