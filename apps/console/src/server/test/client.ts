// A browser-like client of the console's API half booted on a real socket (bootApi): it sends what
// the SPA sends (the exact Origin, `Sec-Fetch-Site: same-origin`, `X-Fin-App: console` and a JSON
// body on unsafe methods; `Fin-Organization` on organisation routes), keeps the host-only cookies it
// is given, and arrives from a connector peer with the client's address in `CF-Connecting-IP`.
// Addresses use example.com only; secrets are made at run time.
import { randomBytes } from "node:crypto";
import { base32Decode, totpCode } from "@fin/orgs/testing";
import type { bootApi } from "@fin/web-host/testing";
import type { Pool } from "pg";

export const HOST = "console.example.com";
export const ORIGIN = `https://${HOST}`;

export type Booted = Awaited<ReturnType<typeof bootApi>>;

export interface Reply {
  status: number;
  json: Record<string, unknown>;
  cookies: string[];
}

export class Client {
  readonly jar = new Map<string, string>();
  // Canonical form (no leading zero), as Postgres's inet writes it back.
  readonly ip = `2001:db8:${(0x1000 + (randomBytes(2).readUInt16BE() % 0xe000)).toString(16)}::7`;
  readonly userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  secret: Uint8Array | null = null;
  readonly #api: Booted;

  constructor(api: Booted) {
    this.#api = api;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const unsafe = method !== "GET" && method !== "HEAD";
    const res = await this.#api.send({
      host: HOST,
      path,
      method,
      headers: {
        "user-agent": this.userAgent,
        "cf-connecting-ip": this.ip,
        ...(unsafe ? { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-fin-app": "console" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.jar.size > 0
          ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = res.headers["set-cookie"];
    const cookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const cookie of cookies) {
      const [pair = ""] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0\b/i.test(cookie) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    let json: Record<string, unknown> = {};
    try {
      json = res.body === "" ? {} : (JSON.parse(res.body) as Record<string, unknown>);
    } catch {
      json = {};
    }
    return { status: res.status, json, cookies };
  }

  /** An organisation route: `Fin-Organization` with the call. */
  org(orgId: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.call(method, path, body, { "fin-organization": orgId, ...headers });
  }
}

/** The newest code emailed to an address. */
export async function latestCode(admin: Pool, email: string): Promise<string> {
  const result = await admin.query<{ code: string }>(
    `SELECT params ->> 'code' AS code FROM email.outbox
      WHERE recipient = $1 AND params ? 'code' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [email],
  );
  const code = result.rows[0]?.code;
  if (code === undefined) throw new Error("no code was queued");
  return code;
}

/** Sets up an authenticator in the client's session (the first factor). */
export async function enrolAuthenticator(client: Client): Promise<void> {
  const enable = await client.call("POST", "/api/auth/two-factor/enable", {});
  if (enable.status !== 200) throw new Error(`enable answered ${enable.status}`);
  const key = new URL(String(enable.json.totpURI)).searchParams.get("secret") ?? "";
  client.secret = base32Decode(key);
  const verify = await client.call("POST", "/api/auth/two-factor/verify-totp", {
    code: totpCode(client.secret, new Date()),
  });
  if (verify.status !== 200) throw new Error(`verify-totp answered ${verify.status}`);
}

/**
 * Runs a stepped-up call as the SPA's `api()` does (spec 02 §7.1, §7.5): the first answer is
 * `403 step_up_required` with an intent; the StepUp ceremony proves it; the same request goes once
 * more with `Fin-Step-Up-Intent`. TOTP steps are accepted once each, so the test forgets the last.
 */
export async function steppedUp(
  admin: Pool,
  client: Client,
  send: (headers: Record<string, string>) => Promise<Reply>,
): Promise<{ asked: Reply; done: Reply }> {
  const asked = await send({});
  if (asked.status !== 403 || asked.json.code !== "step_up_required") return { asked, done: asked };
  const intentId = String(asked.json.intent_id);
  if (client.secret === null) throw new Error("the client has no authenticator");
  await admin.query("UPDATE identity.totp_step SET last_step = 0");
  const proved = await client.call(
    "POST",
    "/api/auth/two-factor/verify-totp",
    { code: totpCode(client.secret, new Date()) },
    { "fin-step-up-intent": intentId },
  );
  if (proved.status !== 200) throw new Error(`the proof answered ${proved.status}`);
  const done = await send({ "fin-step-up-intent": intentId });
  return { asked, done };
}
