// Developer sign-up and sign-in by emailed code (spec 02 §5.1, §5.2, §5.5, §6.1, §2.4):
// the account is made only by a code sign-in in the asking browser while sign-ups are open; one
// live code per address; a browser not known for the address never supersedes a known browser's
// code and may use only its share of the allowance; 3 tries in the asking browser and 3 shared
// elsewhere; the same answers for registered and unknown addresses (T-SAT-32); and every cookie
// the realm sets is host-only __Host-, Secure, HttpOnly, Path=/, the session Strict (T-SAT-04).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  type Answer,
  type Browser,
  codeSignIn,
  createHarness,
  type Harness,
  passkeyCeremony,
  registerPasskey,
} from "../test/harness.ts";
import { codeLinkAsking } from "./codes.ts";
import { signUp } from "./sign-up.ts";

let database: TestDatabase;
let h: Harness;
const allCookies: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase("sign_in");
  h = await createHarness(database, "developer");
});

afterAll(async () => {
  await database.drop();
});

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;

async function post(
  browser: Browser,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Answer> {
  const answer = await browser.post(path, body, headers);
  allCookies.push(...answer.setCookies);
  return answer;
}

const sendCode = (browser: Browser, email: string) =>
  post(browser, "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });

async function userOf(email: string) {
  const result = await h.admin.query<{ id: string; name: string }>(
    'SELECT id, name FROM identity."user" WHERE email = $1',
    [email],
  );
  return result.rows[0] ?? null;
}

describe("a code sign-in for a new address", () => {
  it("makes the account, an aal1 session with the mailbox proved, and their events", async () => {
    const browser = h.browser();
    const email = unique("new");
    const answer = await codeSignIn(h, browser, email);
    allCookies.push(...answer.setCookies);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    const user = await userOf(email);
    expect(user).not.toBeNull();
    const session = await h.admin.query<{
      assurance: string;
      created_via: string;
      mailbox_proved_at: Date | null;
    }>(
      "SELECT assurance, created_via, mailbox_proved_at FROM identity.session WHERE user_id = $1",
      [user?.id],
    );
    expect(session.rows[0]).toMatchObject({ assurance: "aal1", created_via: "email_otp" });
    expect(session.rows[0]?.mailbox_proved_at).toBeInstanceOf(Date);
    const created = (await h.events({ event: "user.created" })).find(
      (e) => e.target_id === user?.id,
    );
    expect(created?.metadata).toEqual({ method: "email_otp", viaInvitation: false });
    expect(
      (await h.events({ event: "session.created" })).some((e) =>
        e.ref_ids.includes(user?.id as string),
      ),
    ).toBe(true);
    // The first sign-in sends no new-sign-in notice; a known-browser cookie is set.
    expect((await h.outbox(email)).map((m) => m.template)).toEqual(["identity/sign-in-code"]);
    expect(answer.setCookies.some((c) => c.startsWith("__Host-fin.known_browser="))).toBe(true);
  });

  it("never makes an account from a browser that did not ask", async () => {
    const asker = h.browser();
    const email = unique("other.browser");
    await sendCode(asker, email);
    const code = (await h.latestCode(email)) as string;
    const stranger = h.browser();
    const refused = await post(stranger, "/api/auth/sign-in/email-otp", { email, otp: code });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ code: "INVALID_OTP" });
    expect(await userOf(email)).toBeNull();
    // The asking browser still has its own tries and signs in.
    const signedIn = await post(asker, "/api/auth/sign-in/email-otp", { email, otp: code });
    expect(signedIn.status).toBe(200);
  });

  it("refuses an unknown address while sign-ups are paused, as a wrong code would", async () => {
    await seed(h.admin, "UPDATE ops.kill_switch SET state = 'on' WHERE name = 'signups'");
    try {
      const browser = h.browser();
      const email = unique("paused");
      await sendCode(browser, email);
      const refused = await post(browser, "/api/auth/sign-in/email-otp", {
        email,
        otp: (await h.latestCode(email)) as string,
      });
      expect(refused.json).toMatchObject({ code: "INVALID_OTP" });
      expect(await userOf(email)).toBeNull();
    } finally {
      await seed(h.admin, "UPDATE ops.kill_switch SET state = 'off' WHERE name = 'signups'");
    }
  });
});

describe("one live code per address (§5.2, S2-38)", () => {
  it("lets a new code from the same browser supersede the old one", async () => {
    const browser = h.browser();
    const email = unique("supersede");
    await sendCode(browser, email);
    const first = (await h.latestCode(email)) as string;
    await sendCode(browser, email);
    const second = (await h.latestCode(email)) as string;
    const old = await post(browser, "/api/auth/sign-in/email-otp", { email, otp: first });
    expect(old.status).not.toBe(200);
    const fresh = await post(browser, "/api/auth/sign-in/email-otp", { email, otp: second });
    expect(fresh.status).toBe(200);
  });

  it("never lets a browser that is not known supersede a known browser's code", async () => {
    const owner = h.browser();
    const email = unique("contested");
    await codeSignIn(h, owner, email); // owner's browser is now known for the address
    await owner.post("/api/auth/sign-out");
    await sendCode(owner, email);
    const ownersCode = (await h.latestCode(email)) as string;
    const stranger = h.browser();
    const contested = await sendCode(stranger, email);
    expect(contested.status).toBe(200);
    expect(contested.json).toEqual({ success: true });
    expect(await h.latestCode(email)).toBe(ownersCode);
    expect(h.lines.named("auth.code_contested").at(-1)).toMatchObject({
      reason: "supersede_refused",
    });
    const signedIn = await post(owner, "/api/auth/sign-in/email-otp", { email, otp: ownersCode });
    expect(signedIn.status).toBe(200);
  });

  it("keeps the rest of the allowance for known browsers once strangers used their share", async () => {
    const email = unique("share");
    for (let i = 0; i < 3; i += 1) expect((await sendCode(h.browser(), email)).status).toBe(200);
    const sent = (await h.outbox(email)).length;
    expect(sent).toBe(3);
    const fourth = await sendCode(h.browser(), email);
    expect(fourth.json).toEqual({ success: true });
    expect((await h.outbox(email)).length).toBe(3);
    expect(h.lines.named("auth.code_contested").at(-1)).toMatchObject({
      reason: "unknown_share_used",
    });
  });
});

describe("tries per code (§5.2)", () => {
  it("gives the asking browser 3 tries and other browsers 3 between them", async () => {
    const owner = h.browser();
    const email = unique("tries");
    await codeSignIn(h, owner, email);
    await owner.post("/api/auth/sign-out");
    await sendCode(owner, email);
    const code = (await h.latestCode(email)) as string;
    for (let i = 0; i < 3; i += 1) {
      const wrong = await post(h.browser(), "/api/auth/sign-in/email-otp", {
        email,
        otp: "00000000",
      });
      expect(wrong.status).toBe(400);
    }
    const fourthStranger = await post(h.browser(), "/api/auth/sign-in/email-otp", {
      email,
      otp: code,
    });
    expect(fourthStranger.status).toBe(403);
    expect(fourthStranger.json).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
    // The owner's browser still has its own three.
    const owners = await post(owner, "/api/auth/sign-in/email-otp", { email, otp: code });
    expect(owners.status, JSON.stringify(owners.json)).toBe(200);
    const failures = await h.events({ event: "sign_in.failed" });
    expect(failures.some((e) => e.metadata.reason === "too_many_tries")).toBe(true);
    expect(failures.some((e) => e.metadata.reason === "wrong_code")).toBe(true);
  });

  it("answers the code-link check only for the asking browser", async () => {
    const browser = h.browser();
    const email = unique("link");
    await sendCode(browser, email);
    const token = browser.jar.get("__Host-fin.code_browser") ?? null;
    const asking = await h.realm.run(browser.context(), (tx) =>
      codeLinkAsking(tx, h.realm.runtime, email, token),
    );
    expect(asking).toBe(true);
    const other = await h.realm.run(browser.context(), (tx) =>
      codeLinkAsking(tx, h.realm.runtime, email, null),
    );
    expect(other).toBe(false);
  });
});

describe("a new sign-in from a browser the account has not used (§5.5)", () => {
  it("queues new-sign-in, and not again from the same browser", async () => {
    const email = unique("notice");
    const first = h.browser();
    await codeSignIn(h, first, email);
    const authenticator = h.authenticator();
    await registerPasskey(first, authenticator);
    const second = h.browser();
    expect((await passkeyCeremony(second, authenticator)).status).toBe(200);
    expect((await passkeyCeremony(second, authenticator)).status).toBe(200);
    const notices = (await h.outbox(email)).filter((m) => m.template === "identity/new-sign-in");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.params).toMatchObject({ device: "Chrome on Mac" });
  });
});

describe("the same answers for registered and unknown addresses (T-SAT-32, AC-SAT-09)", () => {
  const shape = (answer: Answer) => ({
    status: answer.status,
    json: answer.json,
    cookies: answer.setCookies
      .map((c) => c.replace(/=[^;]*/, "=").replace(/Max-Age=\d+/i, "Max-Age"))
      .sort(),
    headers: [...answer.headers.keys()].filter((k) => k !== "set-cookie").sort(),
  });

  it("answers a code request the same way", async () => {
    const registered = unique("registered");
    await codeSignIn(h, h.browser(), registered);
    const a = await sendCode(h.browser(), registered);
    const b = await sendCode(h.browser(), unique("unknown"));
    expect(shape(a)).toEqual(shape(b));
  });

  it("answers sign-up the same way, queueing already-registered for an existing account (S2-05)", async () => {
    const registered = unique("signup.registered");
    await codeSignIn(h, h.browser(), registered);
    const fresh = unique("signup.fresh");
    const browser = h.browser();
    const run = (email: string, b: Browser) =>
      signUp(
        h.realm,
        b.request("POST", "/api/sign-up", { name: "Ada Lovelace", email }),
        b.context(),
        {
          name: "Ada Lovelace",
          email,
        },
      );
    const a = await run(registered, h.browser());
    const b = await run(fresh, browser);
    expect(a.status).toBe(202);
    expect(a.body).toEqual(b.body);
    const names = (cookies: string[]) => cookies.map((c) => c.slice(0, c.indexOf("="))).sort();
    expect(names(a.setCookies)).toEqual(names(b.setCookies));
    expect((await h.outbox(registered)).at(-1)?.template).toBe("identity/already-registered");
    expect((await h.outbox(fresh)).at(-1)?.template).toBe("identity/confirm-email");
    expect(await userOf(fresh)).toBeNull();

    // The code from that browser makes the account with the name the sign-up gave.
    for (const cookie of b.setCookies)
      browser.absorb(new Response(null, { headers: { "set-cookie": cookie } }));
    const code = (await h.latestCode(fresh)) as string;
    const signedIn = await post(browser, "/api/auth/sign-in/email-otp", {
      email: fresh,
      otp: code,
    });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    expect((await userOf(fresh))?.name).toBe("Ada Lovelace");
  });

  it("refuses a bad name with the field's sentence and no address in the answer", async () => {
    const b = h.browser();
    await expect(
      signUp(h.realm, b.request("POST", "/api/sign-up", {}), b.context(), {
        name: "visit example.com",
        email: unique("bad"),
      }),
    ).rejects.toMatchObject({ code: "invalid", extensions: { fields: ["name"] } });
  });
});

describe("every cookie the realm sets ([SA-43], T-SAT-04, AC-SAT-23)", () => {
  it("is host-only __Host-, Secure, HttpOnly, Path=/, with no Domain; the session Strict, the rest Lax", () => {
    expect(allCookies.length).toBeGreaterThan(5);
    const names = new Set<string>();
    for (const cookie of allCookies) {
      const [pair = "", ...attributes] = cookie.split(";").map((p) => p.trim());
      const name = pair.slice(0, pair.indexOf("="));
      names.add(name);
      const lower = attributes.map((a) => a.toLowerCase());
      expect(name, cookie).toMatch(/^__Host-fin\./);
      expect(lower, cookie).toContain("secure");
      expect(lower, cookie).toContain("httponly");
      expect(lower, cookie).toContain("path=/");
      expect(
        lower.some((a) => a.startsWith("domain")),
        cookie,
      ).toBe(false);
      expect(
        lower.some((a) => a.startsWith("partitioned")),
        cookie,
      ).toBe(false);
      const sameSite = lower.find((a) => a.startsWith("samesite="));
      expect(sameSite, cookie).toBe(
        name === "__Host-fin.session_token" ? "samesite=strict" : "samesite=lax",
      );
    }
    expect(names).toContain("__Host-fin.session_token");
    expect(names).toContain("__Host-fin.code_browser");
    expect(names).toContain("__Host-fin.known_browser");
    for (const never of [
      "__Host-fin.dont_remember",
      "__Host-fin.trust_device",
      "__Host-fin.session_data",
    ]) {
      expect(names).not.toContain(never);
    }
  });
});
