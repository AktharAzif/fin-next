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
import { ADDRESS_LOCK_SLOTS, addressLockSlot, codeLinkAsking, lockAddress } from "./codes.ts";
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

  it("keeps one live code when requests for an address overlap, and one asking browser", async () => {
    for (let run = 0; run < 4; run += 1) {
      const email = unique("overlap");
      const a = h.browser();
      const b = h.browser();
      const answers = await Promise.all([sendCode(a, email), sendCode(b, email)]);
      expect(answers.map((x) => x.status)).toEqual([200, 200]);
      const live = await h.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM identity.email_code_request
          WHERE email_hash = $1 AND superseded_at IS NULL AND used_at IS NULL`,
        [h.realm.runtime.hasher.hash("email", email)],
      );
      expect(Number(live.rows[0]?.n)).toBe(1);
      const linked = await Promise.all(
        [a, b].map((x) =>
          h.realm.run(x.context(), (tx) =>
            codeLinkAsking(
              tx,
              h.realm.runtime,
              email,
              x.jar.get("__Host-fin.code_browser") ?? null,
            ),
          ),
        ),
      );
      expect(linked.filter(Boolean)).toHaveLength(1);
      // Only the browser whose request stands makes the account with the code.
      const code = (await h.latestCode(email)) as string;
      const [loser, winner] = linked[0] ? [b, a] : [a, b];
      const refused = await post(loser, "/api/auth/sign-in/email-otp", { email, otp: code });
      expect(refused.status).toBe(400);
      expect(await userOf(email)).toBeNull();
      const signedIn = await post(winner, "/api/auth/sign-in/email-otp", { email, otp: code });
      expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    }
  });

  it.each([
    ["from one network", true],
    ["each from its own network", false],
  ] as const)(
    "finishes overlapping sign-ups, code requests and tries for one address, %s",
    async (_shape, oneNetwork) => {
      // Each unit takes its locks in lockAddress()'s order: sign-up's own limits, the network's code
      // limit, the address's lock, then the address's code limits. From one network, a path that
      // took the network's code limit after the address's lock would wait on another in a circle;
      // each on its own network, nothing makes the units take turns before the address's lock, so a
      // path that took the address's code limits before the lock would. Postgres would end one of
      // them (a sign-up that throws, or a 500).
      for (let run = 0; run < 6; run += 1) {
        for (const registered of [true, false]) {
          const email = unique(registered ? "mixed.registered" : "mixed.fresh");
          if (registered) await codeSignIn(h, h.browser(), email);
          const ip = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}::9`;
          const browser = () => h.browser(oneNetwork ? { ip } : {});
          const up = () => {
            const b = browser();
            return signUp(
              h.realm,
              b.request("POST", "/api/sign-up", { name: "Ada Lovelace", email }),
              b.context(),
              { name: "Ada Lovelace", email },
            ).then(
              (answer) => String(answer.status),
              // A refusal carries its status; anything else (a deadlock) fails the test below.
              (error: { status?: number; code?: string }) =>
                error.status === undefined
                  ? `error ${error.code ?? "unknown"}`
                  : String(error.status),
            );
          };
          const ask = () => sendCode(browser(), email).then((answer) => String(answer.status));
          const guess = () =>
            post(browser(), "/api/auth/sign-in/email-otp", { email, otp: "00000000" }).then(
              (answer) => String(answer.status),
            );
          const statuses = await Promise.all([up(), ask(), guess(), up(), ask(), guess()]);
          for (const status of statuses)
            expect(["200", "202", "400", "403", "429"]).toContain(status);
          // Every browser here is a stranger to the address, so at most one request stands: a code
          // or a codeless request, never both, and never two of either.
          const live = await h.admin.query<{ n: string }>(
            `SELECT count(*) AS n FROM identity.email_code_request
            WHERE email_hash = $1 AND superseded_at IS NULL AND used_at IS NULL`,
            [h.realm.runtime.hasher.hash("email", email)],
          );
          expect(Number(live.rows[0]?.n)).toBeLessThanOrEqual(1);
        }
      }
    },
  );

  it("holds the address's lock as a row only the console's role may lock, never an advisory lock", async () => {
    // Any login may take an advisory lock, and its key shows in pg_locks: one held open would
    // stall every request for the address. The row is the address's slot in a table only
    // fin_console may lock (the grant tests refuse every other role), and while it is held nothing
    // advisory is.
    const email = unique("lock.row");
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = () => {};
    const isHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const first = h.db.unit(async (tx) => {
      await lockAddress(tx, h.realm.runtime, email);
      held();
      await released;
    });
    let secondHeld = false;
    let second: Promise<void> | null = null;
    try {
      await isHeld;
      const advisory = await h.admin.query(
        `SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
          WHERE l.locktype = 'advisory' AND d.datname = current_database()`,
      );
      expect(advisory.rowCount).toBe(0);
      // A second unit for the address waits on the first's row until it ends.
      second = h.db.unit(async (tx) => {
        await lockAddress(tx, h.realm.runtime, email);
        secondHeld = true;
      });
      let waiting = false;
      for (let i = 0; i < 250 && !waiting && !secondHeld; i += 1) {
        const waits = await h.admin.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        waiting = (waits.rowCount ?? 0) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(secondHeld).toBe(false);
      expect(waiting).toBe(true);
    } finally {
      release();
      await first;
      await second;
    }
    expect(secondHeld).toBe(true);
  });

  // Every code request, codeless request and try takes the lock for whatever address the caller
  // sent, before any per-address check. Each used to leave a row for that address that nothing
  // deleted: a table that grew with every address anyone typed and kept when each last asked.
  it("keeps the address lock's table to its fixed slots, whatever addresses callers send", async () => {
    const slots = async () => {
      const result = await h.admin.query<{ n: string; columns: string }>(
        `SELECT (SELECT count(*) FROM identity.email_code_lock) AS n,
                (SELECT string_agg(column_name, ',' ORDER BY column_name)
                   FROM information_schema.columns
                  WHERE table_schema = 'identity' AND table_name = 'email_code_lock') AS columns`,
      );
      return result.rows[0];
    };
    expect(await slots()).toEqual({ n: String(ADDRESS_LOCK_SLOTS), columns: "slot" });
    for (let i = 0; i < 6; i += 1) {
      const browser = h.browser();
      const email = unique(`lock.bounded.${i}`);
      // A wrong try for an address with no account and no code, then a code request for another.
      const tried = await post(browser, "/api/auth/sign-in/email-otp", { email, otp: "00000000" });
      expect(tried.status).toBe(400);
      expect((await sendCode(browser, unique(`lock.bounded.send.${i}`))).status).toBe(200);
    }
    expect(await slots()).toEqual({ n: String(ADDRESS_LOCK_SLOTS), columns: "slot" });
  });

  it("puts each address in one slot, and spreads addresses over the slots", () => {
    const hasher = h.realm.runtime.hasher;
    const email = unique("lock.slot");
    expect(addressLockSlot(hasher, email)).toBe(addressLockSlot(hasher, email.toUpperCase()));
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i += 1) {
      const slot = addressLockSlot(hasher, `slot.${i}@example.com`);
      expect(Number.isInteger(slot) && slot >= 0 && slot < ADDRESS_LOCK_SLOTS).toBe(true);
      seen.add(slot);
    }
    // 2,000 addresses over 65,536 slots: about 30 share one; far more would mean a skewed slot.
    expect(seen.size).toBeGreaterThan(1_900);
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

  it("keeps a stranger who asks again in the strangers' share", async () => {
    const owner = h.browser();
    const email = unique("asks.again");
    await codeSignIn(h, owner, email); // the owner's browser is now known for the address
    await owner.post("/api/auth/sign-out");
    const before = (await h.outbox(email)).length;
    const stranger = h.browser();
    for (let i = 0; i < 4; i += 1) expect((await sendCode(stranger, email)).status).toBe(200);
    // Asking again does not make a browser known: it uses only what is left of the strangers'
    // 3 an hour (the owner's first code, from a browser not yet known, used one).
    expect((await h.outbox(email)).length - before).toBe(2);
    const rows = await h.admin.query<{ browser_known: boolean }>(
      "SELECT browser_known FROM identity.email_code_request WHERE email_hash = $1",
      [h.realm.runtime.hasher.hash("email", email)],
    );
    expect(rows.rows.map((r) => r.browser_known)).toEqual([false, false, false]);
    // The owner's known browser still gets its code, supersedes the stranger's and signs in.
    expect((await sendCode(owner, email)).status).toBe(200);
    expect((await h.outbox(email)).length - before).toBe(3);
    const code = (await h.latestCode(email)) as string;
    const signedIn = await post(owner, "/api/auth/sign-in/email-otp", { email, otp: code });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  });

  it("never lets strangers' requests refuse the owner's known browser", async () => {
    const owner = h.browser();
    const email = unique("flooded");
    await codeSignIn(h, owner, email);
    await owner.post("/api/auth/sign-out");
    // Browsers not known for the address share 6 requests in 10 minutes (the owner's first code,
    // asked before its browser was known, was one of them)...
    for (let i = 0; i < 5; i += 1) expect((await sendCode(h.browser(), email)).status).toBe(200);
    expect((await sendCode(h.browser(), email)).status).toBe(429);
    // ...and a known browser has its own.
    const mine = await sendCode(owner, email);
    expect(mine.status).toBe(200);
    const signedIn = await post(owner, "/api/auth/sign-in/email-otp", {
      email,
      otp: (await h.latestCode(email)) as string,
    });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
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

describe("an address Fin does not accept (§5.2)", () => {
  it("is refused as invalid, whatever the library's own check would let through", async () => {
    const email = `${"a".repeat(65)}@example.com`;
    const browser = h.browser();
    const sent = await sendCode(browser, email);
    expect(sent.status).toBe(400);
    expect(sent.json).toMatchObject({ code: "invalid", fields: ["email"] });
    expect(await h.outbox(email)).toEqual([]);
    expect(await h.latestCode(email)).toBeNull();
  });

  it("signs in nobody with a code Fin holds no live request for, and answers as a wrong code", async () => {
    const browser = h.browser();
    const email = unique("no.request");
    await sendCode(browser, email);
    const code = (await h.latestCode(email)) as string;
    // Fin's request for the code is gone (it lapsed a moment before the library's own copy).
    await seed(
      h.admin,
      `UPDATE identity.email_code_request SET created_at = now() - interval '20 minutes',
              expires_at = now() - interval '1 second' WHERE email_hash = ANY($1)`,
      [h.realm.runtime.hasher.hashes("email", email)],
    );
    const errorsBefore = h.lines.named("auth.unhandled_error").length;
    const refused = await post(browser, "/api/auth/sign-in/email-otp", { email, otp: code });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ code: "INVALID_OTP" });
    expect(await userOf(email)).toBeNull();
    expect(h.lines.named("auth.unhandled_error").length).toBe(errorsBefore);
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
    // Every byte of every Set-Cookie but the tokens themselves, in order.
    const masked = (cookies: string[]) => cookies.map((c) => c.replace(/=[^;]*/, "=<token>"));
    expect(masked(a.setCookies)).toEqual(masked(b.setCookies));
    expect(masked(a.setCookies)).toHaveLength(2);
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

  it("answers sign-up the same way once the network's code requests are used up", async () => {
    const registered = unique("spent.registered");
    await codeSignIn(h, h.browser(), registered);
    const ip = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}::7`;
    const spender = h.browser({ ip });
    for (let i = 0; i < 6; i += 1) {
      expect((await sendCode(spender, unique("spent.other"))).status).toBe(200);
    }
    const run = (email: string) => {
      const b = h.browser({ ip });
      return signUp(
        h.realm,
        b.request("POST", "/api/sign-up", { name: "Ada Lovelace", email }),
        b.context(),
        { name: "Ada Lovelace", email },
      ).then(
        (answer) => ({ status: answer.status, code: null as string | null }),
        (error: { status?: number; code?: string }) => ({
          status: error.status ?? 0,
          code: error.code ?? null,
        }),
      );
    };
    const a = await run(registered);
    const b = await run(unique("spent.fresh"));
    expect(a).toEqual({ status: 429, code: "rate_limited" });
    expect(b).toEqual(a);
  });

  /** Signs up for `email` from a new browser, keeping the cookies the answer sets. */
  async function signedUpBrowser(email: string): Promise<Browser> {
    const asker = h.browser();
    const answer = await signUp(
      h.realm,
      asker.request("POST", "/api/sign-up", { name: "Ada Lovelace", email }),
      asker.context(),
      { name: "Ada Lovelace", email },
    );
    expect(answer.status).toBe(202);
    for (const cookie of answer.setCookies)
      asker.absorb(new Response(null, { headers: { "set-cookie": cookie } }));
    return asker;
  }

  const asking = (b: Browser, email: string) =>
    h.realm.run(b.context(), (tx) =>
      codeLinkAsking(tx, h.realm.runtime, email, b.jar.get("__Host-fin.code_browser") ?? null),
    );

  /** Wrong codes from a browser, as status, body and header names. */
  async function wrongCodes(b: Browser, email: string, times: number) {
    const answers: unknown[] = [];
    for (let i = 0; i < times; i += 1) {
      const answer = await post(b, "/api/auth/sign-in/email-otp", { email, otp: "00000000" });
      answers.push({
        status: answer.status,
        json: answer.json,
        headers: [...answer.headers.keys()].sort(),
      });
    }
    return answers;
  }

  /** What the browser that signed up can see next: the code-link check and its tries. */
  async function afterSignUp(email: string) {
    const asker = await signedUpBrowser(email);
    const linked = await asking(asker, email);
    const tries = await wrongCodes(asker, email, 5);
    const elsewhere = await wrongCodes(h.browser(), email, 4);
    return { linked, tries, elsewhere, stillLinked: await asking(asker, email) };
  }

  it("leaves the browser that signed up the same state for a registered and an unknown address", async () => {
    const registered = unique("state.registered");
    await codeSignIn(h, h.browser(), registered);
    const a = await afterSignUp(registered);
    const b = await afterSignUp(unique("state.fresh"));
    expect(a).toEqual(b);
    expect(b.linked).toBe(true);
    expect((b.tries as { status: number }[]).map((t) => t.status)).toEqual([
      400, 400, 400, 403, 403,
    ]);
    expect((b.elsewhere as { status: number }[]).map((t) => t.status)).toEqual([
      400, 400, 400, 403,
    ]);
    // The registered address got its notice and no code.
    expect((await h.outbox(registered)).at(-1)).toMatchObject({
      template: "identity/already-registered",
      params: {},
    });
  });

  it("leaves the same state while the owner's known browser holds a live code, and never touches that code", async () => {
    const registered = unique("state.contested");
    const owner = h.browser();
    await codeSignIn(h, owner, registered); // the owner's browser is now known for the address
    await owner.post("/api/auth/sign-out");
    await sendCode(owner, registered);
    const ownersCode = (await h.latestCode(registered)) as string;
    const a = await afterSignUp(registered);
    const b = await afterSignUp(unique("state.contested.fresh"));
    expect(a).toEqual(b);
    // The owner's code is still the live one, its browser still the asking one.
    expect(await h.latestCode(registered)).toBe(ownersCode);
    expect(await asking(owner, registered)).toBe(true);
    const signedIn = await post(owner, "/api/auth/sign-in/email-otp", {
      email: registered,
      otp: ownersCode,
    });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  });

  it("leaves the code alone when a known browser of the account signs up with its address", async () => {
    // The browser that asked the code signs up, and so does the owner's other known browser:
    // neither shows anything a known browser does not already know, so neither costs the code.
    for (const signsUp of ["asker", "other"] as const) {
      const registered = unique(`known.signup.${signsUp}`);
      const owner = h.browser();
      await codeSignIn(h, owner, registered); // the owner's browser is now known for the address
      await owner.post("/api/auth/sign-out");
      const other = h.browser();
      await codeSignIn(h, other, registered);
      await other.post("/api/auth/sign-out");
      await sendCode(owner, registered);
      const ownersCode = (await h.latestCode(registered)) as string;
      const b = signsUp === "asker" ? owner : other;
      const answer = await signUp(
        h.realm,
        b.request("POST", "/api/sign-up", { name: "Ada Lovelace", email: registered }),
        b.context(),
        { name: "Ada Lovelace", email: registered },
      );
      expect(answer.status).toBe(202);
      expect((await h.outbox(registered)).at(-1)?.template).toBe("identity/already-registered");
      expect(await h.latestCode(registered)).toBe(ownersCode);
      expect(await asking(owner, registered)).toBe(true);
      const signedIn = await post(owner, "/api/auth/sign-in/email-otp", {
        email: registered,
        otp: ownersCode,
      });
      expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    }
  });

  it("never lets a code through for the registered address's request from sign-up", async () => {
    const registered = unique("state.no.code");
    const owner = h.browser();
    await codeSignIn(h, owner, registered);
    await owner.post("/api/auth/sign-out");
    await sendCode(owner, registered);
    const ownersCode = (await h.latestCode(registered)) as string;
    const asker = await signedUpBrowser(registered);
    // Even the owner's right code fails in the browser that signed up, as a wrong code would.
    const refused = await post(asker, "/api/auth/sign-in/email-otp", {
      email: registered,
      otp: ownersCode,
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ code: "INVALID_OTP" });
    expect(asker.sessionToken()).toBeNull();
    const failed = (await h.events({ event: "sign_in.failed" })).at(-1);
    expect(failed?.metadata).toEqual({ method: "email_otp", reason: "wrong_code" });
    const signedIn = await post(owner, "/api/auth/sign-in/email-otp", {
      email: registered,
      otp: ownersCode,
    });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  });

  it("counts sign-up against the strangers' share of code emails alike for both", async () => {
    // Each address has had one code asked by a browser not known for it (the registered one's
    // first sign-in), so each has 2 of the strangers' 3 an hour left.
    const registered = unique("share.registered");
    await codeSignIn(h, h.browser(), registered);
    const fresh = unique("share.fresh");
    await sendCode(h.browser(), fresh);
    // Sign-up uses one more; then three more browsers ask, and only the first gets a code.
    const probe = async (email: string) => {
      await signedUpBrowser(email);
      const answers: boolean[] = [];
      for (let i = 0; i < 3; i += 1) {
        const b = h.browser();
        expect((await sendCode(b, email)).status).toBe(200);
        answers.push(await asking(b, email));
      }
      return answers;
    };
    const a = await probe(registered);
    const b = await probe(fresh);
    expect(a).toEqual(b);
    expect(b).toEqual([true, false, false]);
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
