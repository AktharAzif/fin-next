// Organisation intents (spec 02 §7.1 to §7.5; T-SAT-30 for this area, AC-SAT-06, AC-SAT-32): an intent
// is bound to its session, person, action, organisation, target and bound fields; it is refused
// unproved, used, expired, of another session, for another action or another organisation, or for
// other parameters; it passes once; two concurrent re-sends with one intent make exactly one action.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, DROP_TIMEOUT_MS, type TestDatabase } from "../test/db.ts";
import {
  asActor,
  codeOf,
  createHarness,
  extensionsOf,
  type Harness,
  memberOf,
  ownerWithOrganization,
  prove,
  type SignedIn,
  unique,
  warmUp,
} from "../test/harness.ts";
import { inviteMember } from "./invitations.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("step_up");
  h = await createHarness(database);
});

// The realm's one-time start, so that the first test's time is its own (test/harness.ts).
beforeAll(async () => {
  await warmUp(h);
});

afterAll(async () => {
  await database?.drop();
}, DROP_TIMEOUT_MS);

function invite(who: SignedIn, orgId: string, email: string, headers: Record<string, string> = {}) {
  return asActor(
    h,
    who,
    orgId,
    { body: { email, roleKey: "admin" }, headers },
    {
      permission: "member.invite",
      lock: true,
      stepUp: { kind: "intent", action: "member.invite" },
    },
    (tx, a) => inviteMember(h.orgs, tx, a, { email, roleKey: "admin" }),
  );
}

async function intentFor(who: SignedIn, orgId: string, email: string): Promise<string> {
  const asked = await invite(who, orgId, email);
  expect(codeOf(asked)).toBe("step_up_required");
  expect(extensionsOf(asked)).toMatchObject({
    step_up_kind: "intent",
    reason_key: "invite_someone",
    methods: ["authenticator", "backup_code"],
  });
  return String(extensionsOf(asked).intent_id);
}

describe("an organisation intent", () => {
  it("is refused unproved, for other parameters, and once used; it passes once", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner");
    const email = unique("bound");
    const intent = await intentFor(who, orgId, email);
    const early = await invite(who, orgId, email, { "fin-step-up-intent": intent });
    expect([codeOf(early), extensionsOf(early).reason]).toEqual(["step_up_invalid", "unproved"]);
    expect((await prove(h, who, intent)).status).toBe(200);
    const other = await invite(who, orgId, unique("other"), { "fin-step-up-intent": intent });
    expect(extensionsOf(other).reason).toBe("digest");
    const done = await invite(who, orgId, email, { "fin-step-up-intent": intent });
    expect(done.ok).toBe(true);
    const again = await invite(who, orgId, unique("again"), { "fin-step-up-intent": intent });
    expect(extensionsOf(again).reason).toBe("digest");
    const replay = await invite(who, orgId, email, { "fin-step-up-intent": intent });
    expect(extensionsOf(replay).reason).toBe("used");
    expect(h.lines.named("step_up.refused").some((l) => l.reason === "used")).toBe(true);
  });

  it("is refused in another organisation, from another session, and once expired", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_scope");
    const second = await ownerWithOrganization(h, "owner_second");
    const email = unique("scoped");
    const intent = await intentFor(who, orgId, email);
    await prove(h, who, intent);
    // The same person, another organisation they are not in: not found before the intent is read.
    const elsewhere = await invite(who, second.orgId, email, { "fin-step-up-intent": intent });
    expect(codeOf(elsewhere)).toBe("not_found");
    // Another person's session naming this intent.
    const thief = await invite(second.who, second.orgId, email, { "fin-step-up-intent": intent });
    expect(extensionsOf(thief).reason).toBe("other_session");
    await h.admin.query(
      "UPDATE ops.step_up_intent SET expires_at = now() - interval '1 second', created_at = now() - interval '6 minutes' WHERE id = $1",
      [intent],
    );
    const late = await invite(who, orgId, email, { "fin-step-up-intent": intent });
    expect(extensionsOf(late).reason).toBe("expired");
  });

  it("is refused for another action of the same organisation", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_action");
    const email = unique("action");
    const intent = await intentFor(who, orgId, email);
    await prove(h, who, intent);
    await h.admin.query("UPDATE ops.step_up_intent SET action = 'member.remove' WHERE id = $1", [
      intent,
    ]);
    const out = await invite(who, orgId, email, { "fin-step-up-intent": intent });
    expect(extensionsOf(out).reason).toBe("other_action");
  });

  it("makes exactly one action from two concurrent re-sends (AC-SAT-32)", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_race");
    const email = unique("race");
    const intent = await intentFor(who, orgId, email);
    await prove(h, who, intent);
    const [a, b] = await Promise.all([
      invite(who, orgId, email, { "fin-step-up-intent": intent }),
      invite(who, orgId, email, { "fin-step-up-intent": intent }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(extensionsOf(loser).reason).toBe("used");
    const rows = await h.admin.query(
      "SELECT 1 FROM identity.invitation WHERE organization_id = $1 AND email = $2",
      [orgId, email],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("needs a factor: a privileged member without one is held, and no intent is made", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_factor");
    const plain = await memberOf(h, who, orgId, "plain", "admin", { factor: false });
    const out = await invite(plain.who, orgId, unique("factor"));
    expect([codeOf(out), extensionsOf(out).hold]).toEqual(["second_factor_required", true]);
    const intents = await h.admin.query(
      "SELECT 1 FROM ops.step_up_intent WHERE principal_id = $1",
      [plain.who.userId],
    );
    expect(intents.rowCount).toBe(0);
  });
});
