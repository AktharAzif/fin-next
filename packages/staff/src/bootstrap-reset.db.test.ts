// The operator's reset of the last Admin on Postgres 18 (spec 02 §10.6, §10.4, §11.4): through
// staff.bootstrap_admin as `migrate --task staff-bootstrap` calls it, as fin_owner in one
// transaction. Like an Admin's reset in Fin Admin, it ends every way in the member had or had
// begun:
//   - a sign-in code emailed before the reset signs no one in after it, and one sent after it
//     signs the member in to enrol with the reset's enrolment code;
//   - an emailed-code sign-in or a passkey sign-in sent while the reset holds the member waits for
//     it and makes no session (the code is void, the passkey gone);
//   - an emailed-code sign-in that holds the member when the reset starts finishes first, and the
//     reset then ends the session it made.
// Each test enrols its own Admin, the only active one, and resets them to pending.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessFor,
  type Browser,
  createStaffHarness,
  type SoftAuthenticator,
  type StaffHarness,
  signInByCode,
  unique,
} from "../test/harness.ts";
import type { PlatformClient } from "../test/platform.mjs";
import { generateEnrolmentCode, hashEnrolmentCode } from "./enrolment-codes.ts";
import { newId } from "./ids.ts";
import { redeemCode } from "./members.ts";
import { requireStaff } from "./require-staff.ts";

let h: StaffHarness;

beforeAll(async () => {
  h = await createStaffHarness("sat04boot");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

interface Admin {
  staffId: string;
  email: string;
  browser: Browser;
  authenticator: SoftAuthenticator;
}

/** A new Admin enrolled with a passkey: the only active one, as the operator's reset requires. */
async function lastAdmin(label: string): Promise<Admin> {
  const email = unique(label);
  return { ...(await h.enrolled(email, "admin")), email };
}

/**
 * The operator's reset of the Admin at `email` with a new enrolment code, run in a transaction of
 * its own that it leaves open: the caller commits it.
 */
async function bootstrapReset(owner: PlatformClient, email: string, code: string) {
  const clock = h.deps.clock;
  const ids = {
    member_id: newId("stf", clock),
    code_id: newId("enc", clock),
    member_event_id: newId("aud", clock),
    code_event_id: newId("aud", clock),
    bootstrap_event_id: newId("aud", clock),
    journal_id: newId("jrn", clock),
  };
  await owner.query("BEGIN");
  return owner.query(
    "SELECT staff.bootstrap_admin($1, $2, true, 'lost_factors', 'run_reset', 'test-release', $3::jsonb) AS answer",
    [email, hashEnrolmentCode(code), JSON.stringify(ids)],
  );
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  return (await h.admin.query(sql, values)).rowCount ?? 0;
}

const sessionsOf = (staffId: string) =>
  count("SELECT 1 FROM staff.session WHERE user_id = $1", [staffId]);

const codesFor = (email: string) =>
  count("SELECT 1 FROM staff.verification WHERE identifier = $1", [`sign-in-otp-${email}`]);

async function statusOf(staffId: string): Promise<string | undefined> {
  const result = await h.admin.query<{ status: string }>(
    "SELECT status FROM staff.member WHERE id = $1",
    [staffId],
  );
  return result.rows[0]?.status;
}

/** Asks a sign-in code for `email` from `browser` and returns it, unsent. */
async function codeFor(browser: Browser, email: string): Promise<string> {
  const sent = await browser.auth("POST", "/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  expect(sent.status).toBe(200);
  const code = await h.latestCode(email);
  if (code === null) throw new Error("no code was queued");
  return code;
}

/** `POST /api/enrolment/redeem` from a pending member's own browser. */
function redeemIn(browser: Browser, code: string) {
  return h.route(
    browser,
    { method: "POST", path: "/api/enrolment/redeem", body: { code } },
    async (tx, req, ctx) =>
      redeemCode(h.deps, tx, await requireStaff(h.realm, req, ctx, { reach: ["pending"] }), code),
  );
}

/**
 * Waits until `n` backends of this test's database wait for a lock another transaction holds, or
 * until `settles` (when given) has settled, whichever comes first.
 */
async function lockWaiters(n: number, settles?: Promise<unknown>): Promise<void> {
  let settled = false;
  settles?.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let tries = 0; tries < 1000; tries += 1) {
    if (settled) return;
    const waiting = await h.admin.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(waiting.rows[0]?.n ?? 0) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${n} backends never waited for a lock`);
}

describe("the operator's reset of the last Admin and the sign-ins begun before it (§10.6, §11.4)", () => {
  it("signs no one in after it with a code emailed before it; a code sent after it signs the member in to enrol", async () => {
    const member = await lastAdmin("boot.code.before");
    const device = h.browser(accessFor(member.email));
    const code = await codeFor(device, member.email);
    expect(await codesFor(member.email)).toBe(1);
    const enrolmentCode = generateEnrolmentCode();
    const owner = await h.platform.owner();
    try {
      await bootstrapReset(owner, member.email, enrolmentCode);
      await owner.query("COMMIT");
    } finally {
      await owner.end();
    }

    expect(await statusOf(member.staffId)).toBe("pending");
    expect(await codesFor(member.email)).toBe(0);
    const signIn = await device.auth("POST", "/sign-in/email-otp", {
      email: member.email,
      otp: code,
    });
    expect(signIn.status).not.toBe(200);
    expect(device.sessionToken()).toBeNull();
    expect(await sessionsOf(member.staffId)).toBe(0);
    // A code sent after the reset signs the member in, pending, and the reset's code enrols them.
    const browser = h.browser(accessFor(member.email));
    await signInByCode(h, browser, member.email);
    expect(await redeemIn(browser, enrolmentCode)).toMatchObject({ ok: true });
  });

  it("leaves no session from an emailed-code sign-in sent while it holds the member: the code is void", async () => {
    const member = await lastAdmin("boot.code.during");
    const device = h.browser(accessFor(member.email));
    const code = await codeFor(device, member.email);
    const owner = await h.platform.owner();
    let answered: number | null = null;
    try {
      await bootstrapReset(owner, member.email, generateEnrolmentCode());
      const signingIn = device.auth("POST", "/sign-in/email-otp", {
        email: member.email,
        otp: code,
      });
      signingIn.catch(() => undefined);
      await lockWaiters(1, signingIn);
      await owner.query("COMMIT");
      answered = (await signingIn).status;
    } finally {
      await owner.end();
    }

    expect(answered).not.toBe(200);
    expect(device.sessionToken()).toBeNull();
    expect(await sessionsOf(member.staffId)).toBe(0);
    expect(await statusOf(member.staffId)).toBe("pending");
  });

  it("leaves no session from a passkey sign-in sent while it holds the member", async () => {
    const member = await lastAdmin("boot.passkey.during");
    const device = h.browser(accessFor(member.email));
    const options = await device.auth("GET", "/passkey/generate-authenticate-options");
    expect(options.status).toBe(200);
    const response = member.authenticator.authenticate(String(options.json?.challenge));
    const owner = await h.platform.owner();
    let answered: number | null = null;
    try {
      await bootstrapReset(owner, member.email, generateEnrolmentCode());
      const signingIn = device.auth("POST", "/passkey/verify-authentication", { response });
      signingIn.catch(() => undefined);
      await lockWaiters(1, signingIn);
      await owner.query("COMMIT");
      answered = (await signingIn).status;
    } finally {
      await owner.end();
    }

    expect(answered).not.toBe(200);
    expect(device.sessionToken()).toBeNull();
    expect(await sessionsOf(member.staffId)).toBe(0);
    expect(await statusOf(member.staffId)).toBe("pending");
  });

  it("waits for an emailed-code sign-in that holds the member, then ends the session it made", async () => {
    const member = await lastAdmin("boot.code.first");
    const device = h.browser(accessFor(member.email));
    const code = await codeFor(device, member.email);
    // Another transaction holds the code's row for a moment, so the sign-in stops there, holding
    // the member; the reset is started meanwhile and queues behind it.
    const blocker = await h.platform.superuser();
    const owner = await h.platform.owner();
    let answered: number | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM staff.verification WHERE identifier = $1 FOR UPDATE", [
        `sign-in-otp-${member.email}`,
      ]);
      const signingIn = device.auth("POST", "/sign-in/email-otp", {
        email: member.email,
        otp: code,
      });
      signingIn.catch(() => undefined);
      await lockWaiters(1);
      const resetting = bootstrapReset(owner, member.email, generateEnrolmentCode());
      resetting.catch(() => undefined);
      await lockWaiters(2, resetting);
      await blocker.query("ROLLBACK");
      answered = (await signingIn).status;
      await resetting;
      await owner.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
      await owner.end();
    }

    expect(answered).toBe(200);
    expect(await sessionsOf(member.staffId)).toBe(0);
    expect(await codesFor(member.email)).toBe(0);
    expect(await statusOf(member.staffId)).toBe("pending");
  });
});
