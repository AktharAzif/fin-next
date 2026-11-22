// Credentials made or seen by someone who leaves ([SA-33], spec 02 §9.4; T-SAT-36, AC-SAT-35): a removal
// and a demotion roll every listed credential of a source by default, in the action's own unit of
// work; at once only when the actor holds the credential's rolling permission, otherwise with a
// 1-hour overlap; the remaining Super admins and Admins are told what was rolled at once and what
// keeps working for the hour.
import type { UnitTx } from "@fin/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, DROP_TIMEOUT_MS, type TestDatabase } from "../test/db.ts";
import {
  asActor,
  changeRoleAs,
  createHarness,
  type Harness,
  memberOf,
  ownerWithOrganization,
  removeAs,
  roleAs,
} from "../test/harness.ts";
import { CredentialRegistry, type CredentialSource } from "./credentials.ts";
import { memberCredentials } from "./members.ts";

let database: TestDatabase;
let h: Harness;
const rolls: { orgId: string; ids: string[]; overlap: "now" | "1h"; unitId: string }[] = [];
const listedIn: string[] = [];

/** A fake API-key source: one Production and one Sandbox key per person, made and seen. */
const source: CredentialSource = {
  kind: "api_key",
  async list(tx: UnitTx, _orgId: string, userId: string) {
    listedIn.push(tx.unitId);
    return [
      { id: `live_${userId.slice(-6)}`, label: "Production key", made: true, seen: true },
      { id: `test_${userId.slice(-6)}`, label: "Sandbox key", made: true, seen: false },
    ];
  },
  rollPermission: (item) => (item.id.startsWith("live_") ? "apiKey.live" : "apiKey.sandbox"),
  async roll(tx, orgId, ids, overlap) {
    rolls.push({ orgId, ids, overlap, unitId: tx.unitId });
  },
};

beforeAll(async () => {
  database = await createTestDatabase("credentials");
  const credentials = new CredentialRegistry();
  credentials.register(source);
  h = await createHarness(database, { credentials });
});

afterAll(async () => {
  await database?.drop();
}, DROP_TIMEOUT_MS);

describe("a removal", () => {
  // Genuinely heavy, so a timeout of its own: a custom role made with a proof, two members, each
  // invited with a proof, signed in, given an authenticator and accepted with a proof, then the
  // removal with its proof. Alone it takes up to 1.4 s; in the full db run on 4 CPUs, up to
  // 2.9 s.
  it("rolls at once what the actor may roll, the rest with an hour's overlap, in the same unit", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner");
    // A role that may invite and remove people and roll only Sandbox keys.
    const removers = await roleAs(h, who, orgId, "Removers", [
      "member.read",
      "member.invite",
      "apiKey.read",
      "apiKey.sandbox",
    ]);
    const remover = await memberOf(h, who, orgId, "remover", removers);
    const leaver = await memberOf(h, who, orgId, "leaver", removers);
    const listing = await asActor(
      h,
      remover.who,
      orgId,
      { method: "GET" },
      { anyOf: ["member.invite", "member.role"], stepUp: { kind: "none" } },
      (tx, a) => memberCredentials(h.orgs, tx, a, leaver.memberId),
    );
    expect(listing.ok && listing.value.credentials.map((c) => [c.label, c.rolledAtOnce])).toEqual([
      ["Production key", false],
      ["Sandbox key", true],
    ]);
    rolls.length = 0;
    const out = await removeAs(h, remover.who, orgId, leaver.memberId);
    expect(out.ok).toBe(true);
    expect(rolls.map((r) => [r.overlap, r.ids.length])).toEqual([
      ["now", 1],
      ["1h", 1],
    ]);
    // Listed and rolled in the removal's own unit of work.
    expect(new Set(rolls.map((r) => r.unitId)).size).toBe(1);
    expect(listedIn).toContain(rolls[0]?.unitId);
    const event = (await h.events({ event: "member.removed", organizationId: orgId })).at(-1);
    expect(event?.metadata).toEqual({ credentialsListed: 2, credentialsRolled: 2 });
    const toOwner = (await h.outbox(who.email)).filter((m) => m.template === "orgs/member-removed");
    expect(toOwner.at(-1)?.params).toMatchObject({
      audience: "admins",
      rolledNow: 1,
      rollingWithinHour: 1,
    });
    const toLeaver = (await h.outbox(leaver.who.email)).filter(
      (m) => m.template === "orgs/member-removed",
    );
    expect(toLeaver.at(-1)?.params).toMatchObject({ audience: "person" });
  }, 20_000);

  it("rolls nothing when asked not to, and still counts what was listed", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_keep");
    const leaver = await memberOf(h, who, orgId, "keeper", "admin");
    rolls.length = 0;
    const out = await removeAs(h, who, orgId, leaver.memberId, false);
    expect(out.ok).toBe(true);
    expect(rolls).toEqual([]);
    const event = (await h.events({ event: "member.removed", organizationId: orgId })).at(-1);
    expect(event?.metadata).toEqual({ credentialsListed: 2, credentialsRolled: 0 });
  });
});

describe("a demotion", () => {
  it("rolls the demoted member's credentials at once when the actor may roll them", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "owner_demote");
    const admin = await memberOf(h, who, orgId, "demoted", "admin");
    const readers = await roleAs(h, who, orgId, "Readers", ["member.read"]);
    rolls.length = 0;
    expect((await changeRoleAs(h, who, orgId, admin.memberId, readers)).ok).toBe(true);
    expect(rolls.map((r) => r.overlap)).toEqual(["now"]);
    expect(rolls[0]?.ids).toHaveLength(2);
  });
});
