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
import { HIDDEN_VALUE, nameSecretShapeIn } from "../src/params.ts";
import { recipientHasher } from "../src/recipient-key.ts";
import type { SenderLimits } from "../src/sender/limits.ts";
import { Sender } from "../src/sender/sender.ts";
import { HAS_DATABASE, openTestDatabase, type TestDatabase } from "../src/testing/db.ts";
import { ENQUEUE_OWNER, FakeTransport, failure, LineRecorder } from "../src/testing/index.ts";

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

/** The error a promise rejects with (the test fails if it resolves). */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

function startClock(): Clock {
  // Just ahead of the database's own clock (rows are due at statement time). It stands still until a
  // test moves it, so the claims of one test share one hourly window wherever the hour is; it never
  // jumps far ahead, which would age a code past its life (rows are stamped with the database's time).
  let t = Date.now() + 2_000;
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
      "TRUNCATE email_private.outbox, email_private.recipient_window, email_private.daily_budget, email_private.delivery_check",
    );
    await db.admin.query(
      `INSERT INTO email_private.send_bucket (name, tokens, refilled_at) VALUES ('cloudflare', 0, '-infinity')
       ON CONFLICT (name) DO UPDATE SET tokens = 0, refilled_at = '-infinity'`,
    );
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
  const invite = (to = "invitee@example.com", orgId = ORG) =>
    queue(
      "fin_console",
      "orgs/invitation",
      {
        invitationId: "inv_01jd0000000000000000000000",
        orgId,
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
    }>("SELECT * FROM email_private.outbox ORDER BY created_at, id");
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
        queue("fin_payments", "identity/sign-in-code", { code: "12345678" }),
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
        "SELECT template, priority, carries_code, enqueued_by, category FROM email_private.outbox ORDER BY priority",
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
        db.as.fin_console.query("SELECT count(*) FROM email_private.outbox"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.as.fin_worker.query("INSERT INTO email_private.outbox (id) VALUES ('x')"),
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
          params: { userId: USER, device: "Safari on macOS", time: TIME },
        });
        await expect(
          enqueue(client, {
            id: newId("eml", clock),
            template: "staff/staff-new-sign-in",
            recipientKind: "address",
            recipient: "a@example.com",
            params: findTemplate("staff/staff-new-sign-in")?.sample as Record<string, unknown>,
          }),
        ).rejects.toMatchObject({ code: "FE001" });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await rows()).toEqual([]);
    });

    it("loads the template grants over the base migration's seeded row, with its class's priority", async () => {
      const r = await db.admin.query<{ role: string; priority: number; carries_secret: boolean }>(
        "SELECT role, priority, carries_secret FROM email.template_grant WHERE template = 'ops/delivery-check'",
      );
      expect(r.rows).toEqual([
        { role: db.roleName("fin_worker"), priority: 4, carries_secret: false },
      ]);
      const signIn = await db.admin.query<{ priority: number; carries_secret: boolean }>(
        "SELECT priority, carries_secret FROM email.template_grant WHERE template = 'identity/sign-in-code'",
      );
      expect(signIn.rows).toEqual([{ priority: 1, carries_secret: true }]);
    });

    it("refuses at queue time params the template refuses, so the action rolls back with it", async () => {
      const client = await db.as.fin_console.connect();
      try {
        await client.query("BEGIN");
        await enqueue(client, {
          id: newId("eml", clock),
          template: "identity/new-sign-in",
          recipientKind: "address",
          recipient: "a@example.com",
          params: { userId: USER, device: "Safari on macOS", time: TIME },
        });
        const secret = ["fin", "live", "abcdefghijklmnop"].join("_");
        const refused = enqueue(client, {
          id: newId("eml", clock),
          template: "identity/new-sign-in",
          recipientKind: "address",
          recipient: "a@example.com",
          params: { userId: USER, device: "Safari on macOS", time: secret },
          dueAt: clock.now() + 365 * 24 * HOUR,
        });
        await expect(refused).rejects.toMatchObject({ code: "FE002", reason: "invalid_params" });
        const error = await failureOf(refused);
        expect(error.message).toContain("time");
        expect(error.message).not.toContain(secret);
        await expect(
          enqueue(client, {
            id: newId("eml", clock),
            template: "orgs/member-removed",
            recipientKind: "address",
            recipient: "a@example.com",
            params: { orgId: ORG, userId: USER, audience: "admins" },
          }),
        ).rejects.toMatchObject({ code: "FE002", reason: "invalid_params" });
        await expect(
          enqueue(client, {
            id: newId("eml", clock),
            template: "identity/no-such-template",
            recipientKind: "address",
            recipient: "a@example.com",
            params: {},
          }),
        ).rejects.toMatchObject({ code: "FE002", reason: "unknown_template" });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await rows()).toEqual([]);
    });

    it("queues and sends notices about ordinary names that hold digits, hyphens and capitals", async () => {
      const sample = (id: string) => findTemplate(id)?.sample as Record<string, unknown>;
      await queue("fin_console", "orgs/member-role-changed", {
        ...sample("orgs/member-role-changed"),
        orgName: "Web3Infrastructure",
      });
      await queue("fin_console", "orgs/member-joined", {
        ...sample("orgs/member-joined"),
        personName: "Anna McKay-Smith",
      });
      await queue("fin_console", "orgs/role-permissions-changed", {
        ...sample("orgs/role-permissions-changed"),
        roleLabel: "Level2-Support-Admins",
      });
      await queue("fin_console", "orgs/member-removed", {
        ...sample("orgs/member-removed"),
        orgName: "Acme-Payments-2025",
      });
      expect(await sender({ concurrency: 6, reservedUrgent: 1 }).runOnce()).toMatchObject({
        sent: 4,
        failed: 0,
      });
      expect(log.named("email.security_unsent")).toEqual([]);
    });

    it("never lets a name spec 02 §8.6 allows refuse the action: each queues in the caller's transaction and is sent, hidden only in a code's shape", async () => {
      const sample = (id: string) => findTemplate(id)?.sample as Record<string, unknown>;
      const cases: readonly [SenderRole, string, Record<string, string>][] = [
        ["fin_console", "orgs/member-removed", { personName: "Ann McKay-Jones" }],
        ["fin_console", "orgs/member-joined", { orgName: "Acme Bank Card 2025" }],
        ["fin_console", "orgs/member-removed", { personName: "Tier2-Agent" }],
        ["fin_console", "orgs/member-removed", { orgName: "Cloud-Ops42" }],
        ["fin_console", "orgs/member-removed", { orgName: "acme2025payments" }],
        ["fin_console", "orgs/member-removed", { personName: "Agent-007ab" }],
        ["fin_console", "orgs/member-role-changed", { roleLabel: "Team4-Alpha" }],
        ["fin_console", "orgs/member-role-changed", { roleLabel: "Tier1-Admin" }],
        ["fin_console", "orgs/role-permissions-changed", { roleLabel: "Tier1-Admin" }],
        ["fin_console", "orgs/organization-deleted", { orgName: "ACME2025PAYMENTS" }],
        ["fin_console", "orgs/organization-deleted", { orgName: "Team7-Alpha" }],
        ["fin_console", "orgs/invitation", { orgName: "Team1-Alpha" }],
        ["fin_console", "orgs/member-joined", { orgName: "Web3 Data Team Peak" }],
        ["fin_admin", "staff/staff-access-changed", { personName: "Abcd1-Efgh2" }],
      ];
      for (const [i, [role, template, names]] of cases.entries()) {
        const client = await db.as[role].connect();
        try {
          await client.query("BEGIN");
          await enqueue(client, {
            id: newId("eml", clock),
            template,
            recipientKind: "address",
            recipient: `member${i}@example.com`,
            params: { ...sample(template), ...names },
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      }
      expect(await sender({ concurrency: 16, reservedUrgent: 1 }).runOnce()).toMatchObject({
        sent: cases.length,
        failed: 0,
      });
      for (const [i, [, template, names]] of cases.entries()) {
        const message = port.sent.find((m) => m.to === `member${i}@example.com`);
        expect(message?.template).toBe(template);
        for (const name of Object.values(names)) {
          // A name in an enrolment or backup code's shape is hidden (T08-23); any other is mailed
          // as it is.
          const shown = nameSecretShapeIn(name) === undefined ? name : HIDDEN_VALUE;
          expect(message?.text, `${template} ${name}`).toContain(shown);
          if (shown !== name) expect(message?.text, `${template} ${name}`).not.toContain(name);
        }
      }
    });

    it("hides a secret-shaped name or device label at queue time: the outbox never holds it, and the notice still goes", async () => {
      const sample = (id: string) => findTemplate(id)?.sample as Record<string, unknown>;
      const key = ["fin", "live", "sk", "0123456789ABCDEFGHIJabcdef"].join("_");
      const label = ["Abcdefgh", "12345678", "Ijkl"].join("");
      await queue(
        "fin_console",
        "orgs/member-removed",
        { ...sample("orgs/member-removed"), personName: key },
        "admin@example.com",
      );
      await queue(
        "fin_console",
        "identity/session-ended",
        { ...sample("identity/session-ended"), device: `Browser ${label} on macOS` },
        "person@example.com",
      );
      const stored = await db.admin.query<{ params: Record<string, unknown> }>(
        "SELECT params FROM email_private.outbox ORDER BY template",
      );
      expect(stored.rows.map((r) => r.params.personName ?? r.params.device)).toEqual([
        "(not shown)",
        "(not shown)",
      ]);
      expect(JSON.stringify(stored.rows)).not.toContain(key);
      expect(JSON.stringify(stored.rows)).not.toContain(label);
      expect(await sender({ concurrency: 6, reservedUrgent: 1 }).runOnce()).toMatchObject({
        sent: 2,
      });
      const all = port.sent.map((m) => `${m.subject}\n${m.text}\n${m.html}`).join("\n");
      expect(all).not.toContain(key);
      expect(all).not.toContain(label);
    });

    it("refuses an unknown recipient kind with FE002, never echoing the row", async () => {
      const secretCode = "48151623";
      for (const kind of ["user", 5, "Address", "staff", []]) {
        const attempt = db.as.fin_console.query("SELECT email.enqueue($1::jsonb)", [
          JSON.stringify({
            id: newId("eml", clock),
            template: "identity/sign-in-code",
            recipient_kind: kind,
            recipient: "victim@example.com",
            params: { code: secretCode },
          }),
        ]);
        const error = (await attempt.then(
          () => undefined,
          (e: unknown) => e,
        )) as { code?: string; message?: string; detail?: string } | undefined;
        expect(error?.code, String(kind)).toBe("FE002");
        const said = `${error?.message ?? ""} ${error?.detail ?? ""}`;
        expect(said).not.toContain("victim");
        expect(said).not.toContain(secretCode);
      }
    });

    it("refuses a NUL or a lone surrogate before the database can echo the input", async () => {
      const lone = String.fromCharCode(0xd800);
      const attempts = [
        // In the address, before the code in the JSON text.
        { recipient: `victim${String.fromCharCode(0)}@example.com`, params: { code: "48151623" } },
        { recipient: `victim${lone}@example.com`, params: { code: "48151623" } },
      ].map(({ recipient, params }) =>
        enqueue(db.as.fin_console, {
          id: newId("eml", clock),
          template: "identity/sign-in-code",
          recipientKind: "address",
          recipient,
          params,
        }),
      );
      for (const attempt of attempts) {
        await expect(attempt).rejects.toMatchObject({ code: "FE002", reason: "bad_input" });
        const error = await failureOf(attempt);
        expect(error.message).not.toContain("victim");
        expect(error.message).not.toContain("48151623");
      }
      expect(await rows()).toEqual([]);
      // In a name after the address, a NUL or a lone surrogate is hidden, never sent to the database.
      for (const personName of [`Ann${lone} Lee`, `Ann${String.fromCharCode(0)} Lee`]) {
        await enqueue(db.as.fin_console, {
          id: newId("eml", clock),
          template: "orgs/member-joined",
          recipientKind: "address",
          recipient: "victim@example.com",
          params: {
            ...(findTemplate("orgs/member-joined")?.sample as Record<string, unknown>),
            personName,
          },
        });
      }
      const stored = await db.admin.query<{ name: string }>(
        "SELECT params->>'personName' AS name FROM email_private.outbox",
      );
      expect(stored.rows).toEqual([{ name: "(not shown)" }, { name: "(not shown)" }]);
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
        "UPDATE email_private.outbox SET leased_by = 'dead:1', lease_until = $1::timestamptz + interval '60 seconds', attempts = 1",
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
      await db.admin.query("UPDATE email_private.outbox SET attempts = 9");
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

    // The caller checked its params at queue time, so a row this worker cannot render was queued by
    // another release (a rolling deploy, or a rollback): it waits for a worker that knows it.
    async function queueRaw(role: SenderRole, template: string, params: Record<string, unknown>) {
      await db.as[role].query("SELECT email.enqueue($1::jsonb)", [
        JSON.stringify({
          id: newId("eml", clock),
          template,
          recipient_kind: "address",
          recipient: "person@example.com",
          params,
        }),
      ]);
    }

    it("keeps a security notice whose template this release does not know, never deleting it unsent", async () => {
      await db.admin.query(
        "INSERT INTO email.template_grant (template, role, category, priority, carries_secret) VALUES ('api-keys/key-changed', $1, 'security', 2, false)",
        [db.roleName("fin_console")],
      );
      await queueRaw("fin_console", "api-keys/key-changed", { orgId: ORG, mode: "live" });
      expect(await sender().runOnce()).toMatchObject({ failed: 1, sent: 0 });
      const [row] = await rows();
      expect(row).toMatchObject({
        template: "api-keys/key-changed",
        last_error_code: "unknown_template",
      });
      expect(new Date(row?.due_at ?? 0).getTime()).toBe(clock.now() + 5 * MINUTE);
      expect(log.named("email.send_failed")[0]?.fields).toMatchObject({
        code: "unknown_template",
        reason: "release",
        final: false,
      });
      expect(log.named("email.security_unsent")).toEqual([]);
      for (let i = 0; i < 6; i++) {
        clock.advance(5 * MINUTE);
        await sender().runOnce();
      }
      expect(await rows()).toHaveLength(1);
      expect(log.named("email.security_unsent")).toHaveLength(1);
      expect(log.named("email.security_unsent")[0]?.fields).toMatchObject({
        reason: "failed",
        final: false,
      });
      // Only after a bound far longer than any deploy does it end, and it says so again.
      clock.advance(7 * 24 * HOUR);
      await sender().runOnce();
      expect(await rows()).toEqual([]);
      expect(log.named("email.security_unsent").at(-1)?.fields).toMatchObject({ final: true });
      expect(port.sent).toHaveLength(0);
    });

    it("keeps a row whose params this release refuses, and ends ordinary mail only after a day", async () => {
      await queueRaw("fin_console", "identity/new-sign-in", {
        userId: USER,
        device: "Safari",
        time: TIME,
        browserKind: "a-param-from-a-newer-release",
      });
      await db.admin.query(
        `INSERT INTO email_private.outbox (id, template, category, priority, recipient_kind, recipient, params, carries_code, due_at, first_due_at, enqueued_by, created_at)
         VALUES ($1, 'ghost/none', 'notice', 3, 'address', 'a@example.com', '{}', false, now(), now(), 'x', now())`,
        [newId("eml", clock)],
      );
      await sender().runOnce();
      expect((await rows()).map((r) => r.last_error_code).sort()).toEqual([
        "invalid_params",
        "unknown_template",
      ]);
      clock.advance(25 * HOUR);
      await sender().runOnce();
      expect((await rows()).map((r) => r.template)).toEqual(["identity/new-sign-in"]);
      expect(
        log.named("email.send_failed").find((l) => l.fields.final === true)?.fields,
      ).toMatchObject({ template: "ghost/none", code: "unknown_template", reason: "release" });
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
      const limits = {
        dailyBudget: 3,
        dailySecurityReserve: 1,
        dailyCodeOnlyReserve: 0,
        dailySecurityOnlyReserve: 1,
        dailyAccountSecurityReserve: 0,
        dailySecurityPerOrganisation: 0,
        dailyPerOrganisation: 1,
        concurrency: 6,
        reservedUrgent: 1,
      };
      for (let i = 0; i < 3; i++) {
        await invite(`p${i}@example.com`, `org_01jd${String(i + 1).padStart(22, "0")}`);
      }
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

    it("never lets other mail to an address use up the backstop its sign-in codes depend on", async () => {
      const limits = { otherPerHour: 2, concurrency: 6, reservedUrgent: 1 };
      for (let i = 0; i < 3; i++) await invite("victim@example.com");
      // Other code templates, even from the same folder and service, have windows of their own.
      for (let i = 0; i < 3; i++) {
        await queue(
          "fin_console",
          "identity/reset-password",
          { code: "11223344" },
          "victim@example.com",
        );
      }
      await sender(limits).runOnce();
      expect(port.of("orgs/invitation")).toHaveLength(2);
      expect(port.of("identity/reset-password")).toHaveLength(2);
      await queue(
        "fin_console",
        "identity/sign-in-code",
        { code: "24682468" },
        "victim@example.com",
      );
      await queue(
        "fin_admin",
        "staff/staff-sign-in-code",
        { code: "13571357" },
        "victim@example.com",
      );
      await sender(limits).runOnce();
      expect(port.of("identity/sign-in-code")).toHaveLength(1);
      expect(port.of("staff/staff-sign-in-code")).toHaveLength(1);
      expect(
        log
          .named("email.send_failed")
          .filter((l) => l.fields.code === "recipient_limit")
          .map((l) => l.fields.template)
          .sort(),
      ).toEqual(["identity/reset-password", "orgs/invitation"]);
      // The backstop still holds for the code template itself.
      for (let i = 0; i < 2; i++) {
        await queue(
          "fin_console",
          "identity/sign-in-code",
          { code: "24682468" },
          "victim@example.com",
        );
      }
      await sender(limits).runOnce();
      expect(port.of("identity/sign-in-code")).toHaveLength(2);
    });

    it("gives back the budget of a send Cloudflare refused, and pauses the loop on a block", async () => {
      const limits = {
        dailyBudget: 4,
        dailySecurityReserve: 1,
        dailyCodeOnlyReserve: 0,
        dailySecurityOnlyReserve: 1,
        dailyAccountSecurityReserve: 0,
        dailySecurityPerOrganisation: 0,
        dailyPerOrganisation: 1,
        concurrency: 6,
        reservedUrgent: 1,
      };
      for (let i = 0; i < 3; i++) await notice(`p${i}@example.com`);
      port.answer(
        failure("blocked", "http_401", { severity: "page" }),
        failure("blocked", "http_401", { severity: "page" }),
        failure("blocked", "http_401", { severity: "page" }),
      );
      const s = sender(limits);
      expect(await s.runOnce()).toMatchObject({ sent: 0, failed: 3 });
      const spent = await db.admin.query<{ count: number }>(
        "SELECT coalesce(sum(count), 0)::int AS count FROM email_private.daily_budget",
      );
      expect(spent.rows[0]?.count).toBe(0);
      // While Cloudflare refuses the token, this loop claims nothing and says so.
      await code();
      expect(await s.runOnce()).toMatchObject({ claimed: 0, paused: true });
      clock.advance(5 * MINUTE);
      expect(await s.runOnce()).toMatchObject({ sent: 4, paused: false });
    });

    it("keeps a share of the day for security notices that codes cannot spend", async () => {
      const limits = {
        dailyBudget: 6,
        dailySecurityReserve: 4,
        dailyCodeOnlyReserve: 2,
        dailySecurityOnlyReserve: 2,
        dailyAccountSecurityReserve: 1,
        dailySecurityPerOrganisation: 0,
        dailyPerOrganisation: 1,
        concurrency: 10,
        reservedUrgent: 1,
      };
      for (let i = 0; i < 5; i++) {
        await queue(
          "fin_console",
          "identity/confirm-email",
          { code: "11223344" },
          `s${i}@example.com`,
        );
      }
      await sender(limits).runOnce();
      expect(port.of("identity/confirm-email")).toHaveLength(4);
      await notice("member@example.com");
      await notice("member2@example.com");
      await sender(limits).runOnce();
      expect(port.of("identity/new-sign-in")).toHaveLength(2);
      expect(log.named("email.security_unsent")).toEqual([]);
    });

    it("gives security notices a ceiling per organisation, so one cannot spend the day", async () => {
      const limits = { dailySecurityPerOrganisation: 2, concurrency: 6, reservedUrgent: 1 };
      for (let i = 0; i < 3; i++) {
        await queue(
          "fin_console",
          "orgs/role-permissions-changed",
          findTemplate("orgs/role-permissions-changed")?.sample as Record<string, unknown>,
          `holder${i}@example.com`,
        );
      }
      await sender(limits).runOnce();
      expect(port.of("orgs/role-permissions-changed")).toHaveLength(2);
      const [waiting] = await rows();
      expect(waiting).toMatchObject({ last_error_code: "budget" });
      expect(log.named("email.security_unsent")[0]?.fields).toMatchObject({ reason: "budget" });
      expect(log.named("email.budget_reached")[0]?.fields).toMatchObject({
        scope: "organisation",
        orgId: ORG,
      });
      await code();
      await sender(limits).runOnce();
      expect(port.of("identity/sign-in-code")).toHaveLength(1);
    });

    /** Queues one organisation's bypass notice (it names the organisation, so it counts against it). */
    const orgNotice = (orgId: string, to: string) =>
      queue(
        "fin_console",
        "orgs/role-permissions-changed",
        {
          ...(findTemplate("orgs/role-permissions-changed")?.sample as Record<string, unknown>),
          orgId,
        },
        to,
      );
    const orgIds = (n: number) =>
      Array.from({ length: n }, (_, i) => `org_01jd${String(i + 1).padStart(22, "0")}`);

    /** Runs the sender until a pass claims nothing (rows held until tomorrow are not claimed). */
    async function drain(s: Sender): Promise<void> {
      for (let i = 0; i < 20; i++) if ((await s.runOnce()).claimed === 0) return;
      throw new Error("the outbox did not drain");
    }

    it("keeps the account share for notices that name no organisation, after ordinary mail, organisations' notices and codes", async () => {
      const limits = {
        dailyBudget: 20,
        dailySecurityReserve: 10,
        dailyCodeOnlyReserve: 3,
        dailySecurityOnlyReserve: 5,
        dailyAccountSecurityReserve: 2,
        dailySecurityPerOrganisation: 2,
        dailyPerOrganisation: 5,
        concurrency: 16,
        reservedUrgent: 1,
      };
      // Ordinary mail has used its part of the day first.
      await db.admin.query(
        "INSERT INTO email_private.daily_budget (day, scope, count) VALUES ($1::date, 'environment', 10)",
        [new Date(clock.now()).toISOString().slice(0, 10)],
      );
      const s = sender(limits);
      for (const [i, org] of orgIds(4).entries()) {
        for (let j = 0; j < 3; j++) await orgNotice(org, `holder${i}-${j}@example.com`);
      }
      await drain(s);
      for (let i = 0; i < 8; i++) {
        await queue(
          "fin_console",
          "identity/sign-in-code",
          { code: "12345678" },
          `c${i}@example.com`,
        );
      }
      await drain(s);
      expect(port.of("identity/sign-in-code").length).toBeGreaterThan(0);
      // Sign-in alerts for two other people are still sent that day.
      await notice("first@example.com");
      await notice("second@example.com");
      await drain(s);
      expect(port.of("identity/new-sign-in")).toHaveLength(2);
    });

    it("never spends a token on a row the budget holds back, holds it until the next UTC day, and lets other organisations' mail go", async () => {
      const limits = {
        bucket: { name: "cloudflare", capacity: 5, ratePerSecond: 0.001 },
        bucketReserve: 1,
        dailySecurityPerOrganisation: 1,
        concurrency: 6,
        reservedUrgent: 1,
      };
      const [orgA, orgB] = orgIds(2) as [string, string];
      for (let i = 0; i < 4; i++) await orgNotice(orgA, `holder${i}@example.com`);
      expect(await sender(limits).runOnce()).toMatchObject({ sent: 1, deferred: 3 });
      const bucket = await db.admin.query<{ tokens: number }>(
        "SELECT tokens FROM email_private.send_bucket WHERE name = 'cloudflare'",
      );
      expect(Number(bucket.rows[0]?.tokens)).toBeCloseTo(4, 1);
      const tomorrow = Math.floor(clock.now() / (24 * HOUR)) * 24 * HOUR + 24 * HOUR;
      const held = await rows();
      expect(held).toHaveLength(3);
      for (const r of held) {
        expect(r).toMatchObject({ attempts: 0, last_error_code: "budget" });
        expect(new Date(r.due_at).getTime()).toBeGreaterThanOrEqual(tomorrow);
      }
      expect(log.named("email.security_unsent").map((l) => l.fields.reason)).toEqual([
        "budget",
        "budget",
        "budget",
      ]);

      // Another organisation's notice and invitation, and a code, all still go at once.
      await orgNotice(orgB, "member@example.com");
      await queue(
        "fin_console",
        "orgs/invitation",
        {
          ...(findTemplate("orgs/invitation")?.sample as Record<string, unknown>),
          orgId: orgB,
        },
        "invitee@example.com",
      );
      await code();
      expect(await sender(limits).runOnce()).toMatchObject({ sent: 3, deferred: 0 });
      expect(port.of("orgs/invitation")).toHaveLength(1);
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

    it("keeps ageing the rows the token bucket holds back", async () => {
      const limits = { bucket: { name: "cloudflare", capacity: 1, ratePerSecond: 1 / 600 } };
      for (let i = 0; i < 3; i++) await code(String(30_000_000 + i));
      const s = sender(limits);
      expect(await s.runOnce()).toMatchObject({ sent: 1, deferred: 2 });
      for (let i = 0; i < 4; i++) {
        clock.advance(60_000);
        await s.runOnce();
      }
      const waiting = await rows();
      expect(waiting).toHaveLength(2);
      expect(waiting.every((r) => r.attempts === 0)).toBe(true);
      expect((await s.age()).urgentS).toBeGreaterThanOrEqual(240);
    });

    it("puts back a missing token bucket row instead of holding all mail", async () => {
      await db.admin.query("DELETE FROM email_private.send_bucket");
      await notice();
      expect(await sender().runOnce()).toMatchObject({ sent: 1 });
      const bucket = await db.admin.query("SELECT name FROM email_private.send_bucket");
      expect(bucket.rows).toEqual([{ name: "cloudflare" }]);
    });

    it("sweeps old windows and budgets", async () => {
      await notice();
      await sender().runOnce();
      clock.advance(9 * 24 * HOUR);
      await sender().sweep();
      const left = await db.admin.query(
        "SELECT 1 FROM email_private.recipient_window UNION ALL SELECT 1 FROM email_private.daily_budget",
      );
      expect(left.rows).toEqual([]);
    });
  });

  describe("email_private: the worker's tables, out of every other login's reach", () => {
    // Postgres takes a statement's table lock before it checks the statement's privileges (a PREPARE
    // when it is parsed; CREATE RULE and CREATE TRIGGER queue theirs before the ownership check), so
    // a login that can name a table can hold it up. One with no USAGE on the schema cannot name it.
    const OTHERS = ["fin_console", "fin_admin", "fin_api", "fin_payments"] as const;
    const PROBE = "test/enqueue-probe";

    async function relations(kinds: string): Promise<string[]> {
      const r = await db.admin.query<{ name: string }>(
        `SELECT 'email_private.' || c.relname AS name FROM pg_class c
         WHERE c.relnamespace = 'email_private'::regnamespace AND c.relkind = ANY ($1::"char"[])
         ORDER BY 1`,
        [kinds.split("")],
      );
      return r.rows.map((row) => row.name);
    }

    it("holds the outbox and the five sender and delivery-check tables, with nothing for PUBLIC", async () => {
      expect(await relations("r")).toEqual([
        "email_private.daily_budget",
        "email_private.delivery_check",
        "email_private.delivery_check_turn",
        "email_private.outbox",
        "email_private.recipient_window",
        "email_private.send_bucket",
      ]);
      const left = await db.admin.query<{ name: string }>(
        "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'email'::regnamespace AND c.relkind = 'r'",
      );
      expect(left.rows).toEqual([{ name: "template_grant" }]);
      const publicAcl = await db.admin.query(
        `SELECT c.relname FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         WHERE c.relnamespace = 'email_private'::regnamespace AND a.grantee = 0
         UNION ALL
         SELECT n.nspname FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
         WHERE n.nspname = 'email_private' AND a.grantee = 0`,
      );
      expect(publicAcl.rows).toEqual([]);
      // USAGE for the worker and enqueue's owner; CREATE for nobody but the schema's owner.
      const acl = await db.admin.query<{ grantee: string; privilege: string }>(
        `SELECT pg_get_userbyid(a.grantee) AS grantee, a.privilege_type AS privilege
         FROM pg_namespace n, aclexplode(n.nspacl) a
         WHERE n.nspname = 'email_private' AND a.grantee <> n.nspowner`,
      );
      expect(acl.rows.map((r) => `${r.privilege} ${r.grantee}`).sort()).toEqual(
        [`USAGE ${db.roleName(ENQUEUE_OWNER)}`, `USAGE ${db.roleName("fin_worker")}`].sort(),
      );
    });

    it("runs email.enqueue() as a role that cannot log in, holding only INSERT on the outbox and SELECT on the template grants", async () => {
      const owner = db.roleName(ENQUEUE_OWNER);
      const fn = await db.admin.query(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                r.rolcanlogin AS can_login
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.oid = 'email.enqueue(jsonb)'::regprocedure`,
      );
      expect(fn.rows).toEqual([
        {
          owner,
          definer: true,
          config: ["search_path=pg_catalog, pg_temp"],
          can_login: false,
        },
      ]);
      const tables = await db.admin.query<{ name: string; privilege: string }>(
        `SELECT n.nspname || '.' || c.relname AS name, p.privilege
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
         WHERE n.nspname IN ('email', 'email_private', 'ops') AND c.relkind = 'r'
           AND has_table_privilege($1, c.oid, p.privilege)
         ORDER BY 1, 2`,
        [owner],
      );
      expect(tables.rows).toEqual([
        { name: "email.template_grant", privilege: "SELECT" },
        { name: "email_private.outbox", privilege: "INSERT" },
      ]);
      const schemas = await db.admin.query(
        `SELECT n.nspname AS name, has_schema_privilege($1, n.oid, 'USAGE') AS usage,
                has_schema_privilege($1, n.oid, 'CREATE') AS create
         FROM pg_namespace n WHERE n.nspname IN ('email', 'email_private', 'ops') ORDER BY 1`,
        [owner],
      );
      expect(schemas.rows).toEqual([
        { name: "email", usage: true, create: false },
        { name: "email_private", usage: true, create: false },
        { name: "ops", usage: false, create: false },
      ]);
      // EXECUTE for the five sending services and nobody else: not PUBLIC, not a login directly.
      const grantees = await db.admin.query<{ grantee: string }>(
        `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
         FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = 'email.enqueue(jsonb)'::regprocedure AND a.grantee <> p.proowner`,
      );
      expect(grantees.rows.map((r) => r.grantee).sort()).toEqual(
        SENDER_ROLES.map((role) => db.roleName(role)).sort(),
      );
    });

    it("still lets each caller with EXECUTE queue a row, which only the worker may then read", async () => {
      for (const role of SENDER_ROLES) {
        await db.admin.query(
          `INSERT INTO email.template_grant (template, role, category, priority, carries_secret)
           VALUES ($1, $2, 'notice', 3, false)`,
          [PROBE, db.roleName(role)],
        );
      }
      try {
        for (const role of SENDER_ROLES) {
          const id = newId("eml", clock);
          const queued = await db.as[role].query<{ id: string }>(
            "SELECT email.enqueue($1::jsonb) AS id",
            [JSON.stringify({ id, template: PROBE, recipient: "a@example.com", params: {} })],
          );
          expect(queued.rows).toEqual([{ id }]);
          const row = await db.admin.query(
            "SELECT template, enqueued_by FROM email_private.outbox WHERE id = $1",
            [id],
          );
          expect(row.rows).toEqual([{ template: PROBE, enqueued_by: db.loginName(role) }]);
          const read = db.as[role].query("SELECT id FROM email_private.outbox WHERE id = $1", [id]);
          if (role === "fin_worker") await expect(read).resolves.toMatchObject({ rows: [{ id }] });
          else await expect(read).rejects.toMatchObject({ code: "42501" });
        }
      } finally {
        await db.admin.query("DELETE FROM email.template_grant WHERE template = $1", [PROBE]);
      }
    });

    it("refuses every other login any name in it before any lock: a SELECT, a PREPARE, a rule or a trigger", async () => {
      const names = await relations("ri");
      expect(names.length).toBeGreaterThan(6);
      // The test's superuser holds every table in the schema: a statement that locked before it
      // checked would wait, and end with the lock timeout (55P03), not with 42501.
      const holder = await db.admin.connect();
      try {
        await holder.query("BEGIN");
        for (const name of await relations("r")) {
          await holder.query(`LOCK TABLE ${name} IN ACCESS EXCLUSIVE MODE`);
        }
        for (const role of OTHERS) {
          const client = await db.as[role].connect();
          try {
            await client.query("SET lock_timeout = '2s'");
            for (const name of names) {
              for (const sql of [
                `SELECT 1 FROM ${name}`,
                `PREPARE p AS SELECT 1 FROM ${name}`,
                `CREATE RULE r AS ON INSERT TO ${name} DO NOTHING`,
                `CREATE TRIGGER t BEFORE UPDATE ON ${name} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
              ]) {
                await client.query("BEGIN");
                const error = await failureOf(client.query(sql));
                expect({ role, sql, code: (error as { code?: string }).code }).toEqual({
                  role,
                  sql,
                  code: "42501",
                });
                expect(error.message).toBe("permission denied for schema email_private");
                await client.query("ROLLBACK");
              }
            }
            // Nor through the search path, which skips a schema the login may not use.
            await client.query("SET search_path = email_private");
            await expect(client.query("SELECT 1 FROM outbox")).rejects.toMatchObject({
              code: "42P01",
            });
          } finally {
            client.release(true);
          }
        }
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    }, 30_000);
  });
});
