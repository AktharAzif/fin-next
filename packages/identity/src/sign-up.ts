// POST /api/sign-up's core (spec 02 §5.1, S2-05): no user row exists until the mailbox is proved.
// The answer is always `202 { status: "code_sent" }` with the same cookies, whether the address
// is unknown (a sign-up request is kept and a code sent) or already registered (the
// `already-registered` notice goes instead). The route (L-SAT-06) runs it after the origin gate.
//
// "The same" is checked to the byte (T-SAT-32): both branches count the same limits before they
// part, and every cookie in the answer is written by serializeFinCookie() here, never copied from
// the library's own serializer, whose attribute order differs. What they leave behind is the same
// too: the registered branch records a codeless request for the browser where the unknown one
// records its code's, so the browser's next steps (a code tried, the code-link check, a code
// asked again) answer alike.
import { codeSendSubject, lockAddress, requestCodeless } from "./codes.ts";
import { finCookieName, readCookie, serializeFinCookie } from "./cookies.ts";
import { randomToken } from "./crypto/keyed.ts";
import { AuthRefusal } from "./errors.ts";
import { checkName } from "./names.ts";
import { assertNewPassword } from "./passwords/policy.ts";
import { signUpPasswordHash } from "./passwords/sign-up.ts";
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

/** The cookie header with one cookie set to `value` (added, or replacing the one sent). */
function withCookie(cookieHeader: string | null, name: string, value: string): string {
  const others = (cookieHeader ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c !== "" && !c.startsWith(`${name}=`));
  return [...others, `${name}=${value}`].join("; ");
}

export async function signUp(
  realm: Realm,
  request: Request,
  context: RequestContext,
  input: { name: unknown; email: unknown; password?: unknown },
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
    // The password rule before any limit is counted, so a refused password costs no allowance;
    // the hash after them, for a registered and an unknown address alike (§5.7).
    if (input.password !== undefined && input.password !== null) {
      if (!rt.settings.features.passwords) {
        throw new AuthRefusal("invalid", "passwords.off", {
          fields: ["password"],
          problem: "password_not_offered",
        });
      }
      assertNewPassword(input.password, "password", { email });
    }

    // Velocity per network and per address ([SA-40]), then the code request's own limits
    // (`code_send` per network and per address, §5.6), counted here for both branches so that a
    // used-up allowance refuses a registered and an unknown address alike. The code asked for
    // below is therefore not counted again. The order is lockAddress()'s, the one every path takes:
    // sign-up's own limits (`sign_up_address` is taken by sign-up alone), then the network's code
    // limit, then the address's lock, then the address's code requests, so a sign-up, a code
    // request and a code try never wait on each other in a circle.
    for (const [bucket, subject] of [
      ["sign_up_network", rt.hasher.bucket("network", state.network)],
      ["sign_up_address", rt.hasher.bucket("email", email)],
      ["code_send", rt.hasher.bucket("network", state.network)],
      ["lock", null],
      ["code_send", codeSendSubject(rt.hasher, email, false)],
    ] as const) {
      if (subject === null) {
        await lockAddress(tx, rt, email);
        continue;
      }
      const result = await rt.limits.consume(tx, bucket, subject);
      if (!result.allowed) {
        throw new AuthRefusal("rate_limited", `limits.${bucket}`, {
          retry_after: result.retryAfter,
        });
      }
    }
    state.codeSendCounted = true;
    const passwordHash = await signUpPasswordHash(rt, input.password, email);

    const cookieHeader = request.headers.get("cookie");
    const sent = (cookie: "sign_up_browser" | "code_browser" | "known_browser"): string | null => {
      const value = readCookie(cookieHeader, finCookieName("developer", cookie));
      return value !== null && TOKEN.test(value) ? value : null;
    };
    const signUpToken = sent("sign_up_browser") ?? randomToken();
    const codeToken = sent("code_browser") ?? randomToken();
    const setCookies = [
      serializeFinCookie("developer", "sign_up_browser", signUpToken),
      serializeFinCookie("developer", "code_browser", codeToken),
    ];

    const person = await personByEmail(tx, "developer", email);
    if (person !== null) {
      // No code (§5.1): the notice goes instead. In the code's place the browser gets a codeless
      // request, bound to `codeToken` and counted against the same share and allowance of code
      // emails, which no code passes and which leaves a code the owner's known browser holds alone.
      // A browser known for the account gets none and leaves every live request as it was.
      const recorded = await requestCodeless(tx, rt, {
        email,
        browserToken: codeToken,
        knownBrowserToken: sent("known_browser"),
        userId: person.id,
      });
      // The line carries what the unknown branch's would: the reason only when nothing is recorded
      // (and for a known browser, which an unknown address never has).
      if (!recorded.recorded) state.line.reason = `codes.${recorded.reason}`;
      await rt.email(tx, { template: "identity/already-registered", to: email, params: {} });
      return { status: 202, body: { status: "code_sent" }, setCookies };
    }

    const now = rt.clock.now();
    await tx.query(
      `INSERT INTO identity.sign_up_request
         (id, email, name, browser_hash, created_at, expires_at, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId("sur", rt.clock),
        email,
        name.value,
        rt.hasher.hash("sign_up_browser", signUpToken),
        now,
        new Date(now.getTime() + DAY),
        passwordHash,
      ],
    );
    // The code goes through the library, from this browser, holding the two tokens the answer
    // sets: the hook binds the code to `codeToken` and finds the sign-up request by `signUpToken`.
    const headers = new Headers(request.headers);
    headers.set(
      "cookie",
      withCookie(
        withCookie(cookieHeader, finCookieName("developer", "sign_up_browser"), signUpToken),
        finCookieName("developer", "code_browser"),
        codeToken,
      ),
    );
    const asked = (await realm.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers,
      returnHeaders: true,
    })) as { headers: Headers | null };
    // The hook sets only the code-browser cookie, to the token given; anything else would make
    // this answer differ from the registered one (or bind the code to a token the browser never
    // gets), so it fails closed.
    const codeCookie = `${finCookieName("developer", "code_browser")}=`;
    for (const cookie of asked.headers?.getSetCookie() ?? []) {
      const value = cookie.startsWith(codeCookie)
        ? cookie.slice(codeCookie.length).split(";")[0]
        : null;
      if (value !== codeToken) {
        throw new Error("identity: the code request set a cookie signUp() does not answer with");
      }
    }
    return { status: 202, body: { status: "code_sent" }, setCookies };
  });
}
