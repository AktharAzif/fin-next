import { describe, expect, it } from "vitest";
import { isFixtureAddress } from "../email/sink.ts";
import { createAddressBook } from "./addresses.ts";
import { CANON, type Canon, type CanonWriter, checkCanon, scopeCanon, seedCanon } from "./index.ts";
import { seededRandom, seedFromEnv } from "./random.ts";

describe("the canon", () => {
  it("is sound", () => {
    expect(checkCanon(CANON)).toEqual([]);
  });

  it("uses fixture addresses only", () => {
    for (const entry of [...CANON.people, ...CANON.staff]) {
      expect(isFixtureAddress(entry.email)).toBe(true);
    }
  });

  it("covers the roles the role matrix needs (spec 06 §8.2)", () => {
    const acme = CANON.organisations.find((o) => o.key === "acme");
    expect(acme?.customRoles.map((r) => r.key)).toEqual([
      "developer",
      "compliance",
      "billing",
      "read_only",
    ]);
    expect(new Set(acme?.members.map((m) => m.role))).toEqual(
      new Set(["admin", "developer", "compliance", "billing", "read_only"]),
    );
    expect(new Set(CANON.staff.map((s) => s.role))).toEqual(
      new Set(["admin", "operator", "compliance", "viewer"]),
    );
  });

  it("finds what is wrong with a broken canon", () => {
    const broken: Canon = {
      ...CANON,
      people: [...CANON.people, { key: "asha", name: "Twin", email: "ASHA.RAO@example.com" }],
      organisations: [
        {
          key: "bad",
          name: "Bad",
          founder: "nobody",
          customRoles: [{ key: "admin", name: "Admin", description: "", permissions: [] }],
          members: [
            { person: "ben", role: "ghost" },
            { person: "ben", role: "super_admin" },
          ],
        },
      ],
      staff: [{ key: "x", name: "X", email: "x@elsewhere.test", role: "viewer" }],
    };
    const problems = checkCanon(broken);
    expect(problems).toEqual(
      expect.arrayContaining([
        "the key asha is used twice",
        "asha's address is used twice",
        "x's address is not a fixture",
        "bad's founder is not a person",
        "bad gives ben an unknown role",
        "ben joins bad twice",
        "bad's only Super admin is its founder",
        "admin holds no permission",
        "admin shadows a built-in",
      ]),
    );
  });
});

function recordingWriter() {
  const steps: string[] = [];
  const writer: CanonWriter = {
    async addStaffMember(member) {
      steps.push(`staff ${member.key} ${member.role}`);
      return `stf_${member.key}`;
    },
    async signUp(person, organisation) {
      steps.push(`sign-up ${person.email} ${organisation.key}`);
      return { person: `usr_${person.key}`, organisation: `org_${organisation.key}` };
    },
    async createCustomRole(organisation, role, actor) {
      steps.push(`role ${organisation} ${role.key} by ${actor}`);
      return `rol_${role.key}`;
    },
    async addMember(organisation, person, role, actor) {
      steps.push(
        `member ${organisation} ${person.email} ${role.key}${role.id ? ` ${role.id}` : ""} by ${actor}`,
      );
      return { person: `usr_${person.key}`, membership: `mem_${person.key}` };
    },
  };
  return { steps, writer };
}

describe("seedCanon", () => {
  it("writes staff (the Admin first), then each organisation's founder, roles and members", async () => {
    const { steps, writer } = recordingWriter();
    const seeded = await seedCanon(writer);
    expect(steps.slice(0, 5)).toEqual([
      "staff grace admin",
      "staff hiro operator",
      "staff ines compliance",
      "staff jonas viewer",
      "sign-up asha.rao@example.com acme",
    ]);
    expect(steps).toContain("role org_acme developer by usr_asha");
    expect(steps).toContain("member org_acme ben.okafor@example.com admin by usr_asha");
    expect(steps).toContain(
      "member org_acme chen.wei@example.com developer rol_developer by usr_asha",
    );
    expect(steps.at(-1)).toBe(
      "member org_globex ben.okafor@example.com read_only rol_read_only by usr_gita",
    );
    expect(seeded.people.get("femi")).toBe("usr_femi");
    expect(seeded.organisations.get("globex")).toBe("org_globex");
    expect(seeded.roles.get("acme/billing")).toBe("rol_billing");
    expect(seeded.staff.size).toBe(4);
  });

  it("seeds a subset, without staff, in a test's scope", async () => {
    const { steps, writer } = recordingWriter();
    const book = createAddressBook("run1-test2");
    await seedCanon(writer, { organisations: ["globex"], staff: false, address: book.scoped });
    expect(steps).toEqual([
      "sign-up gita.menon+run1-test2@example.net globex",
      "role org_globex read_only by usr_gita",
      "member org_globex ben.okafor+run1-test2@example.com read_only rol_read_only by usr_gita",
    ]);
  });

  it("refuses an unsound canon before writing anything", async () => {
    const { steps, writer } = recordingWriter();
    const unsound = scopeCanon(CANON, () => "same@example.com");
    await expect(seedCanon(writer, {}, unsound)).rejects.toThrow("not sound");
    expect(steps).toEqual([]);
  });
});

describe("addresses", () => {
  it("scopes every address it makes", () => {
    const book = createAddressBook("Run 7 / Test:ABC");
    expect(book.scope).toBe("run-7-test-abc");
    expect(book.address("asha")).toBe("asha+run-7-test-abc@example.com");
    expect(book.address("asha")).toBe(book.address("asha"));
    expect(book.address("dara", "example.org")).toBe("dara+run-7-test-abc@example.org");
    expect(book.fresh("x")).not.toBe(book.fresh("x"));
    expect(book.scoped("asha.rao+old@example.com")).toBe("asha.rao+run-7-test-abc@example.com");
  });

  it("refuses what would not be a fixture address", () => {
    const book = createAddressBook("s");
    expect(() => book.address("Not Valid")).toThrow();
    expect(() => book.scoped("someone@elsewhere.test")).toThrow("only fixture");
    expect(() => book.scoped("nobody")).toThrow();
    expect(() => createAddressBook("///")).toThrow();
  });
});

describe("seededRandom", () => {
  it("gives the same sequence for the same seed", () => {
    const a = seededRandom("T-SAT-08");
    const b = seededRandom("T-SAT-08");
    const draws = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(draws);
    expect(seededRandom("other").next()).not.toBe(draws[0]);
  });

  it("stays in range and covers it", () => {
    const random = seededRandom(1);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const value = random.int(1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
      const float = random.next();
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
    expect(seen.size).toBe(6);
  });

  it("shuffles, samples and picks without losing items", () => {
    const random = seededRandom("s");
    const items = ["a", "b", "c", "d", "e"];
    expect(random.shuffle(items).sort()).toEqual(items);
    const sample = random.sample(items, 3);
    expect(new Set(sample).size).toBe(3);
    expect(items).toContain(random.pick(items));
    expect(random.bytes(16)).toHaveLength(16);
    expect(() => random.pick([])).toThrow();
    expect(() => random.sample(items, 6)).toThrow();
    expect(() => random.int(2, 1)).toThrow();
  });

  it("forks independent streams", () => {
    const one = seededRandom("root");
    const two = seededRandom("root");
    two.next();
    expect(one.fork("roles").next()).toBe(two.fork("roles").next());
  });

  it("takes FIN_TEST_SEED to replay a failure", () => {
    expect(seedFromEnv("default", {})).toBe("default");
    expect(seedFromEnv("default", { FIN_TEST_SEED: "replay" })).toBe("replay");
  });
});
