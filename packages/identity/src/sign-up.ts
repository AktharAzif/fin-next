// POST /api/sign-up's core (spec 02 §5.1, S2-05): no user row exists until the mailbox is proved.
// The answer is always `202 { status: "code_sent" }` with the same cookies, whether the address
// is unknown (a sign-up request is kept and a code sent) or already registered (the
// `already-registered` notice goes instead). The route (L-SAT-06) runs it after the origin gate.
import { finCookieName, readCookie, serializeFinCookie } from "./cookies.ts";
import { randomToken } from "./crypto/keyed.ts";
import { AuthRefusal } from "./errors.ts";
import { checkName } from "./names.ts";
import { DAY } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";
import type { Realm } from "./realm.ts";
import type { RequestContext } from "./request.ts";
import { personByEmail } from "./store.ts";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface SignUpAnswer {
  status: 202;
  body: { status: "code_sent" };
  setCookies: string[];
}

export async function signUp(
  realm: Realm,
  request: Request,
  context: RequestContext,
  input: { name: unknown; email: unknown },
): Promise<SignUpAnswer> {
  if (realm.settings.realm !== "developer") throw new Error("signUp is the developer realm's");
  const rt = realm.runtime;
  return realm.run(context, async (tx, state) => {
    if ((await rt.killSwitch(tx, "signups")) === "on")
      throw new AuthRefusal("paused", "switch.signups");
    const name = checkName("personName", typeof input.name === "string" ? input.name : "");
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const fields = [...(name.ok ? [] : ["name"]), ...(EMAIL.test(email) ? [] : ["email"])];
    if (!name.ok || fields.length > 0) throw new AuthRefusal("invalid", "body.invalid", { fields });

    // Velocity per network and per address ([SA-40]): the same refusal for every address.
    for (const [bucket, subject] of [
      ["sign_up_network", rt.hasher.bucket("network", state.network)],
      ["sign_up_address", rt.hasher.bucket("email", email)],
    ] as const) {
      const result = await rt.limits.consume(tx, bucket, subject);
      if (!result.allowed) {
        throw new AuthRefusal("rate_limited", `limits.${bucket}`, {
          retry_after: result.retryAfter,
        });
      }
    }

    const cookieHeader = request.headers.get("cookie");
    const existingSignUpToken = readCookie(
      cookieHeader,
      finCookieName("developer", "sign_up_browser"),
    );
    const signUpToken =
      existingSignUpToken !== null && TOKEN.test(existingSignUpToken)
        ? existingSignUpToken
        : randomToken();
    const setCookies = [serializeFinCookie("developer", "sign_up_browser", signUpToken)];

    const person = await personByEmail(tx, "developer", email);
    if (person !== null) {
      await rt.email(tx, { template: "identity/already-registered", to: email, params: {} });
      // The same cookies as a code request sets, so the two answers cannot be told apart.
      const existingCodeToken = readCookie(
        cookieHeader,
        finCookieName("developer", "code_browser"),
      );
      setCookies.push(
        serializeFinCookie(
          "developer",
          "code_browser",
          existingCodeToken !== null && TOKEN.test(existingCodeToken)
            ? existingCodeToken
            : randomToken(),
        ),
      );
      return { status: 202, body: { status: "code_sent" }, setCookies };
    }

    const now = rt.clock.now();
    await tx.query(
      `INSERT INTO identity.sign_up_request (id, email, name, browser_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        newId("sur", rt.clock),
        email,
        name.value,
        rt.hasher.hash("sign_up_browser", signUpToken),
        now,
        new Date(now.getTime() + DAY),
      ],
    );
    // The code goes through the library, from this browser, with the sign-up cookie it now holds.
    const headers = new Headers(request.headers);
    const others = (cookieHeader ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter(
        (c) => c !== "" && !c.startsWith(`${finCookieName("developer", "sign_up_browser")}=`),
      );
    headers.set(
      "cookie",
      [...others, `${finCookieName("developer", "sign_up_browser")}=${signUpToken}`].join("; "),
    );
    const sent = (await realm.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers,
      returnHeaders: true,
    })) as { headers: Headers | null };
    for (const cookie of sent.headers?.getSetCookie() ?? []) setCookies.push(cookie);
    return { status: 202, body: { status: "code_sent" }, setCookies };
  });
}
