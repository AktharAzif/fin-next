// The sender on a real Postgres 18 (spec 08 T08-21, T08-22, T08-25; ARCHITECTURE §9.4, §9.5):
// enqueue's allowlist and stamps, claiming and leasing, priorities, retries and backoff, the
// never-dropped rule and the digest, the token bucket, budgets and the recipient backstop. The
// sender runs as the worker's own login, so the grants are proven too.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findTemplate,
  rolesFor,
  SENDER_ROLES,
  type SenderRole,
  TEMPLATES,
} from "../src/catalogue.ts";
import { newId } from "../src/ids.ts";
import { enqueue, outboxAge, type RecipientKind } from "../src/outbox/store.ts";
import { recipientHasher } from "../src/recipient-key.ts";
import type { SenderLimits } from "../src/sender/limits.ts";
import { Sender } from "../src/sender/sender.ts";
import { HAS_DATABASE, openTestDatabase, type TestDatabase } from "../src/testing/db.ts";
import { FakeTransport, failure, LineRecorder } from "../src/testing/index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LINKS = { console: "https://console.example.com", admin: "https://staff.example.com" };
const AUTH = { address: "account-security@auth.example.com", name: "Fin" };
const NOTIFY = { address: "team@notify.example.com", name: "Fin" };
const hash = recipientHasher({ version: 1, secret: new Uint8Array(32).fill(3) });
const TIME = "2026-11-21T04:30:00.000Z";
const USER = "usr_01jd0000000000000000000000";
const ORG = "org_01jd0000000000000000000000";

interface Clock {
  now(): number;
  advance(ms: number): void;
}

function startClock(): Clock {
  // Ahead of the database's own clock (rows are due at statement time), and never in an hour's last
  // quarter, so one test's notices share one hourly window.
  let t = Date.now() + 2_000;
  if (new Date(t).getUTCMinutes() >= 45) t = Math.ceil(t / HOUR) * HOUR + MINUTE;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe.skipIf(!HAS_DATABASE)("the sender on Postgres 18", () => {
  let db: TestDatabase;
  let clock: Clock;
  let port: FakeTransport;
  let log: LineRecorder;

  beforeAll(async () => {
    db = await openTestDatabase("sender");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.admin.query(
      "TRUNCATE email.outbox, email.recipient_window, email.daily_budget, email.delivery_check",
    );
    await db.admin.query("UPDATE email.send_bucket SET tokens = 0, refilled_at = '-infinity'");
    clock = startClock();
    port = new FakeTransport();
    log = new LineRecorder();
  });

  function sender(
    limits: Partial<SenderLimits> = {},
    holder = "worker-a:1",
    from: { notify?: typeof NOTIFY } = { notify: NOTIFY },
  ) {
    return new Sender({
      db: db.as.fin_worker,
      port,
      clock,
      log,
      holder,
      environment: "staging",
      from: { auth: AUTH, ...from },
      links: LINKS,
      hashRecipient: hash,
      limits,
      random: () => 0.5,
      newEntityRef: () => "ref",
    });
  }

  async function queue(
    role: SenderRole,
    template: string,
    params: Record<string, unknown>,
    recipient = "person@example.com",
    recipientKind: RecipientKind = "address",
  ): Promise<string> {
    return enqueue(db.as[role], {
      id: newId("eml", clock),
      template,
      recipientKind,
      recipient,
      params,
    });
  }

  const code = (c = "12345678") => queue("fin_console", "identity/sign-in-code", { code: c });
  const notice = (to = "person@example.com") =>
    queue(
      "fin_console",
      "identity/new-sign-in",
      { userId: USER, device: "Safari on macOS", time: TIME },
      to,
    );
  const invite = (to = "invitee@example.com") =>
    queue(
      "fin_console",
      "orgs/invitation",
      {
        invitationId: "inv_01jd0000000000000000000000",
        orgId: ORG,
        token: "Abcdefghijklmnopqrstuvwxyz012345",
        orgName: "Example Payments",
        roleLabel: "Developer",
      },
      to,
    );

  async function rows() {
    const r = await db.admin.query<{
      id: string;
      template: string;
      attempts: number;
      due_at: Date;
      last_error_code: string | null;
      folded_into: string | null;
      security_unsent_at: Date | null;
      leased_by: string | null;
    }>("SELECT * FROM email.outbox ORDER BY created_at, id");
    return r.rows;
  }

  describe("email.enqueue()", () => {
    it("refuses every template outside each role's folders with FE001, and allows the rest (T08-22)", async () => {
      for (const role of SENDER_ROLES) {
        for (const t of TEMPLATES) {
          const attempt = queue(role, t.id, t.sample as Record<string, unknown>);
          if (rolesFor(t).includes(role)) await expect(attempt).resolves.toMatch(/^eml_/u);
          else await expect(attempt).rejects.toMatchObject({ code: "FE001" });
        }
      }
      await expect(
        queue("fin_payments", "identity/sign-in-code", { code: "1" }),
      ).rejects.toMatchObject({ code: "FE001" });
    });

    it("stamps the caller's login and takes the priority and secret flag from the grant, never the caller", async () => {
      await queue("fin_console", "identity/sign-in-code", { code: "12345678" });
      await queue(
        "fin_worker",
        "ops/delivery-check",
        (findTemplate("ops/delivery-check")?.sample ?? {}) as Record<string, unknown>,
      );
      const r = await db.admin.query<{
        template: string;
        priority: number;
        carries_code: boolean;
        enqueued_by: string;
        category: string;
      }>(
        "SELECT template, priority, carries_code, enqueued_by, category FROM email.outbox ORDER BY priority",
      );
      expect(r.rows).toEqual([
        {
          template: "identity/sign-in-code",
          priority: 1,
          carries_code: true,
          enqueued_by: db.loginName("fin_console"),
          category: "code",
        },
        {
          template: "ops/delivery-check",
          priority: 4,
          carries_code: false,
          enqueued_by: db.loginName("fin_worker"),
          category: "ops",
        },
      ]);
    });

    it("refuses bad input with FE002", async () => {
      const bad = async (p: Record<string, unknown>) =>
        db.as.fin_console.query("SELECT email.enqueue($1::jsonb)", [JSON.stringify(p)]);
      const ok = {
        id: newId("eml", clock),
        template: "identity/sign-in-code",
        recipient: "a@example.com",
        params: { code: "12345678" },
      };
      await expect(bad({ ...ok, id: "eml_bad" })).rejects.toMatchObject({ code: "FE002" });
      await expect(bad({ ...ok, recipient: "not an address" })).rejects.toMatchObject({
        code: "FE002",
      });
      await expect(
        bad({ ...ok, recipient_kind: "customer", recipient: "a@example.com" }),
      ).rejects.toMatchObject({ code: "FE002" });
      await expect(bad({ ...ok, params: { blob: "x".repeat(5000) } })).rejects.toMatchObject({
        code: "FE002",
      });
      await expect(bad({ ...ok, params: [1] })).rejects.toMatchObject({ code: "FE002" });
    });

    it("gives no service but the worker a direct write on the outbox", async () => {
      await expect(
        db.as.fin_console.query("SELECT count(*) FROM email.outbox"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.as.fin_worker.query("INSERT INTO email.outbox (id) VALUES ('x')"),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("rolls back with the caller's transaction, so a failed notice undoes the action (T08-24)", async () => {
      const client = await db.as.fin_console.connect();
      try {
        await client.query("BEGIN");
        await enqueue(client, {
          id: newId("eml", clock),
          template: "identity/new-sign-in",
          recipientKind: "address",
          recipient: "a@example.com",
          params: {},
        });
        await expect(
          enqueue(client, {
            id: newId("eml", clock),
            template: "staff/staff-new-sign-in",
            recipientKind: "address",
            recipient: "a@example.com",
            params: {},
          }),
        ).rejects.toMatchObject({ code: "FE001" });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await rows()).toEqual([]);
    });
  });

  describe("claiming and sending", () => {
    it("sends codes first, then security notices, then ordinary mail, and deletes each sent row", async () => {
      await invite();
      await notice();
      await code();
      // Two slots, one kept for urgent mail: the code and the notice go first, the invitation next.
      const s = sender({ concurrency: 2, reservedUrgent: 1 });
      expect(await s.runOnce()).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
      expect(port.sent.map((m) => m.template).sort()).toEqual([
        "identity/new-sign-in",
        "identity/sign-in-code",
      ]);
      expect(await s.runOnce()).toMatchObject({ claimed: 1, sent: 1 });
      expect(port.sent[2]?.template).toBe("orgs/invitation");
      expect(port.sent[2]?.from).toEqual(NOTIFY);
      expect(port.of("identity/sign-in-code")[0]?.from).toEqual(AUTH);
      expect(port.of("identity/sign-in-code")[0]?.headers).toEqual({
        "Auto-Submitted": "auto-generated",
        "X-Entity-Ref-ID": "ref",
        "X-Fin-Category": "code",
      });
      expect(await rows()).toEqual([]);
      const sent = log.named("email.sent");
      expect(sent.map((l) => l.fields.template).sort()).toEqual([
        "identity/new-sign-in",
        "identity/sign-in-code",
        "orgs/invitation",
      ]);
      expect(log.text()).not.toContain("@");
      expect(log.text()).not.toContain("12345678");
    });

    it("keeps a share of each batch for codes and security notices", async () => {
      for (let i = 0; i < 6; i++) await invite(`p${i}@example.com`);
      const result = await sender({ concurrency: 4, reservedUrgent: 1 }).runOnce();
      expect(result).toMatchObject({ claimed: 3, sent: 3, full: true });
    });

    it("never lets two replicas send one row, and reclaims a row whose lease expired", async () => {
      for (let i = 0; i < 8; i++) await code(String(10_000_000 + i));
      const [a, b] = await Promise.all([
        sender({}, "worker-a:1").runOnce(),
        sender({}, "worker-b:1").runOnce(),
      ]);
      expect(a.claimed + b.claimed).toBe(8);
      expect(new Set(port.sent.map((m) => m.text)).size).toBe(8);

      await code("87654321");
      // A replica claims and dies before sending: the row stays leased until the lease ends.
      await db.as.fin_worker.query(
        "UPDATE email.outbox SET leased_by = 'dead:1', lease_until = $1::timestamptz + interval '60 seconds', attempts = 1",
        [new Date(clock.now()).toISOString()],
      );
      expect((await sender().runOnce()).claimed).toBe(0);
      clock.advance(61_000);
      expect(await sender().runOnce()).toMatchObject({ claimed: 1, sent: 1 });
    });
  });

  describe("retries", () => {
    it("waits out a throttle and sends later; the row keeps its attempt count", async () => {
      port.answer(failure("throttled", "cf_10004", { retryAfterMs: 120_000 }));
      await notice();
      expect(await sender().runOnce()).toMatchObject({ failed: 1 });
      const [row] = await rows();
      expect(row).toMatchObject({ attempts: 1, last_error_code: "cf_10004", leased_by: null });
      expect(new Date(row?.due_at ?? 0).getTime()).toBe(clock.now() + 120_000);
      expect(log.named("email.send_failed")[0]?.fields).toMatchObject({
        final: false,
        retryInS: 120,
        reason: "throttled",
      });

      expect((await sender().runOnce()).claimed).toBe(0);
      clock.advance(120_000);
      expect(await sender().runOnce()).toMatchObject({ sent: 1 });
      expect(log.named("email.sent")[0]?.fields).toMatchObject({ attempt: 2 });
      expect(await rows()).toEqual([]);
    });

    it("waits five minutes after a token or account refusal", async () => {
      port.answer(failure("blocked", "cf_10203", { severity: "page" }));
      await code();
      await sender().runOnce();
      const [row] = await rows();
      expect(new Date(row?.due_at ?? 0).getTime()).toBe(clock.now() + 5 * MINUTE);
    });

    it("drops a code once it has outlived its code, never sending a stale one", async () => {
      port.answer(failure("unknown", "timeout"));
      await code();
      await sender().runOnce();
      expect(await rows()).toHaveLength(1);
      clock.advance(16 * MINUTE);
      expect(await sender().runOnce()).toMatchObject({ failed: 1, sent: 0 });
      expect(port.sent).toHaveLength(1);
      expect(await rows()).toEqual([]);
      expect(log.named("email.send_failed").at(-1)?.fields).toMatchObject({
        code: "expired",
        final: true,
      });
    });

    it("ends ordinary mail after its last attempt", async () => {
      await invite();
      await db.admin.query("UPDATE email.outbox SET attempts = 9");
      port.answer(failure("unknown", "cf_10002"));
      await sender().runOnce();
      expect(await rows()).toEqual([]);
      expect(log.named("email.send_failed")[0]?.fields).toMatchObject({ final: true, attempt: 10 });
    });

    it("never ends a security notice on a retryable failure, and says so once after five attempts", async () => {
      await notice();
      for (let i = 0; i < 7; i++) {
        port.answer(failure("unknown", "cf_10002"));
        await sender().runOnce();
        clock.advance(31 * MINUTE);
      }
      const [row] = await rows();
      expect(row).toMatchObject({ attempts: 7 });
      expect(row?.security_unsent_at).not.toBeNull();
      const unsent = log.named("email.security_unsent");
      expect(unsent).toHaveLength(1);
      expect(unsent[0]?.fields).toMatchObject({ reason: "failed", final: false });
      expect(await sender().runOnce()).toMatchObject({ sent: 1 });
    });

    it("writes email.security_unsent when a security notice's recipient is suppressed (T08-25)", async () => {
      port.answer(failure("permanent", "suppressed"));
      await notice();
      await sender().runOnce();
      expect(await rows()).toEqual([]);
      expect(log.named("email.security_unsent")[0]?.fields).toMatchObject({
        template: "identity/new-sign-in",
        reason: "suppressed",
        final: true,
      });
    });

    it("ends a row whose params no longer render, and one whose template is unknown", async () => {
      await queue("fin_console", "identity/new-sign-in", {
        userId: USER,
        device: "Safari",
        time: "yesterday",
      });
      await db.admin.query(
        `INSERT INTO email.outbox (id, template, category, priority, recipient_kind, recipient, params, carries_code, due_at, enqueued_by, created_at)
         VALUES ($1, 'ghost/none', 'notice', 3, 'address', 'a@example.com', '{}', false, now(), 'x', now())`,
        [newId("eml", clock)],
      );
      await sender().runOnce();
      expect(await rows()).toEqual([]);
      const codes = log
        .named("email.send_failed")
        .map((l) => l.fields.code)
        .sort();
      expect(codes).toEqual(["invalid_params", "unknown_template"]);
      expect(log.named("email.security_unsent")[0]?.fields).toMatchObject({ reason: "failed" });
      expect(port.sent).toHaveLength(0);
    });

    it("holds notify mail when no notify sender is configured, as configuration", async () => {
      await invite();
      expect(await sender({}, "worker-a:1", {}).runOnce()).toMatchObject({ failed: 1 });
      expect((await rows())[0]).toMatchObject({ last_error_code: "no_sender" });
    });
  });

  describe("the never-dropped rule and the digest (T08-21)", () => {
    it("sends five notices alone, folds the sixth, and sends one digest with the right counts", async () => {
      for (let i = 0; i < 5; i++) await notice();
      expect(await sender().runOnce()).toMatchObject({ sent: 4 });
      // A restart in the middle: a new process, a new holder, the same count in Postgres.
      expect(await sender({}, "worker-b:2").runOnce()).toMatchObject({ sent: 1 });
      await notice();
      await queue("fin_console", "identity/sign-in-methods-changed", {
        userId: USER,
        kind: "passkey_added",
        time: TIME,
      });
      expect(await sender({}, "worker-b:2").runOnce()).toMatchObject({ folded: 2, sent: 0 });
      expect(log.named("email.folded")).toHaveLength(2);
      expect(String(log.named("email.folded")[0]?.fields.digestKey)).toMatch(
        /^dig_[0-9a-f]{32}_\d{10}$/u,
      );

      const s = sender();
      expect(await s.flushDigests()).toBe(0);
      clock.advance(10 * MINUTE);
      expect(await s.flushDigests()).toBe(1);
      expect((await rows()).map((r) => r.template)).toEqual(["ops/security-digest"]);
      await s.runOnce();
      const digest = port.of("ops/security-digest");
      expect(digest).toHaveLength(1);
      expect(digest[0]?.to).toBe("person@example.com");
      expect(digest[0]?.text).toContain("There were 2 changes");
      expect(digest[0]?.text).toContain("Sign-ins from new browsers: 1");
      expect(digest[0]?.text).toContain("Changes to how you sign in: 1");
      expect(log.named("email.sent").at(-1)?.fields).toMatchObject({
        template: "ops/security-digest",
        folded: 2,
      });
      expect(await rows()).toEqual([]);
    });

    it("never folds a bypass template", async () => {
      for (let i = 0; i < 8; i++) {
        await queue("fin_console", "orgs/member-joined", {
          orgId: ORG,
          userId: USER,
          orgName: "Example",
          roleLabel: "Admin",
        });
      }
      await sender({ concurrency: 8, reservedUrgent: 1 }).runOnce();
      expect(port.of("orgs/member-joined")).toHaveLength(8);
      expect(log.named("email.folded")).toHaveLength(0);
    });

    it("counts each recipient separately", async () => {
      for (let i = 0; i < 6; i++) await notice(`p${i}@example.com`);
      await sender({ concurrency: 6, reservedUrgent: 1 }).runOnce();
      expect(port.sent).toHaveLength(6);
    });
  });

  describe("the token bucket, budgets and the backstop", () => {
    it("defers ordinary mail at the bucket's reserve and still sends codes from it", async () => {
      const limits = {
        bucket: { name: "cloudflare", capacity: 3, ratePerSecond: 0.001 },
        bucketReserve: 2,
      };
      await invite();
      await invite("other@example.com");
      // Three tokens and a reserve of two: one invitation goes, the other waits with its attempt back.
      expect(await sender(limits).runOnce()).toMatchObject({ sent: 1, deferred: 1 });
      const [waiting] = await rows();
      expect(waiting).toMatchObject({ template: "orgs/invitation", attempts: 0 });
      // The reserve is still there for a code.
      await code();
      expect(await sender(limits).runOnce()).toMatchObject({ sent: 1 });
      expect(port.of("identity/sign-in-code")).toHaveLength(1);
    });

    it("keeps the daily budget's security share from ordinary mail, and holds ordinary mail until tomorrow", async () => {
      const limits = { dailyBudget: 3, dailySecurityReserve: 1, concurrency: 6, reservedUrgent: 1 };
      for (let i = 0; i < 3; i++) await invite(`p${i}@example.com`);
      const r = await sender(limits).runOnce();
      expect(r).toMatchObject({ sent: 2, deferred: 1 });
      const [held] = await rows();
      expect(new Date(held?.due_at ?? 0).getTime()).toBeGreaterThan(
        Math.ceil(clock.now() / (24 * HOUR)) * 24 * HOUR - 1,
      );
      expect(log.named("email.budget_reached")[0]?.fields).toMatchObject({
        share: "ordinary",
        scope: "environment",
      });

      await notice();
      expect(await sender(limits).runOnce()).toMatchObject({ sent: 1 });
      expect(log.named("email.budget_reached").at(-1)?.fields).toMatchObject({ share: "security" });

      await code();
      await notice("second@example.com");
      await sender(limits).runOnce();
      // The budget is spent: the code is dropped, the security notice waits and says so.
      const left = await rows();
      expect(left.map((x) => x.template).sort()).toEqual([
        "identity/new-sign-in",
        "orgs/invitation",
      ]);
      expect(log.named("email.security_unsent")[0]?.fields).toMatchObject({ reason: "budget" });
      expect(
        log.named("email.send_failed").find((l) => l.fields.template === "identity/sign-in-code")
          ?.fields,
      ).toMatchObject({ code: "budget", final: true });
    });

    it("limits ordinary mail per organisation", async () => {
      for (let i = 0; i < 3; i++) await invite(`p${i}@example.com`);
      const r = await sender({
        dailyPerOrganisation: 2,
        concurrency: 6,
        reservedUrgent: 1,
      }).runOnce();
      expect(r).toMatchObject({ sent: 2, deferred: 1 });
      expect(log.named("email.budget_reached")[0]?.fields).toMatchObject({
        scope: "organisation",
        orgId: ORG,
      });
    });

    it("ends ordinary mail past the per-recipient backstop", async () => {
      for (let i = 0; i < 3; i++) await invite();
      await sender({ otherPerHour: 2, concurrency: 6, reservedUrgent: 1 }).runOnce();
      expect(port.sent).toHaveLength(2);
      expect(log.named("email.send_failed")[0]?.fields).toMatchObject({
        code: "recipient_limit",
        final: true,
      });
    });
  });

  describe("monitoring readings", () => {
    it("reports how long the oldest code or security row has waited", async () => {
      await notice();
      await invite();
      clock.advance(90_000);
      const age = await outboxAge(db.as.fin_worker, clock.now());
      expect(age.urgentS).toBeGreaterThanOrEqual(90);
      expect(age.otherS).toBeGreaterThanOrEqual(90);
      expect(age.waiting).toBe(2);
    });

    it("sweeps old windows and budgets", async () => {
      await notice();
      await sender().runOnce();
      clock.advance(9 * 24 * HOUR);
      await sender().sweep();
      const left = await db.admin.query(
        "SELECT 1 FROM email.recipient_window UNION ALL SELECT 1 FROM email.daily_budget",
      );
      expect(left.rows).toEqual([]);
    });
  });
});
