// The role editor's name rules, what a name reads as, and a property over random drafts.
import { describe, expect, it } from "vitest";
import { dashboardCatalogue as dash } from "../catalogue/dashboard/index.ts";
import { staffCatalogue as staff } from "../catalogue/staff/index.ts";
import { propertyRuns, propertySeeds, seeded } from "../test-support/seeded.ts";
import { missingNeed } from "./permissions.ts";
import { normaliseRoleText, readingOf, readsAsBuiltIn, validateRole } from "./role-editor.ts";
import { permissionsOf } from "./roles.ts";
import type { Catalogue, RoleProblem } from "./types.ts";

// Typed loosely, as a route handler holds them before the schema narrows a body.
const anyDash: Catalogue = dash;
const all = (cat: Catalogue) => new Set(cat.keys);
const nameProblems = (name: string, cat: Catalogue = dash) =>
  validateRole(cat, { name, description: "", permissions: ["customers.read"] }, all(cat)).filter(
    (p) => p === "name" || p === "reads_as_built_in",
  );

describe("normaliseRoleText", () => {
  it("is NFC, trimmed, with every run of white space one space", () => {
    expect(normaliseRoleText("  Support \t desk \n")).toBe("Support desk");
    expect(normaliseRoleText("Cafe\u{301}")).toBe("Café");
    expect(normaliseRoleText("a\u{a0}b")).toBe("a b");
  });
});

describe("role names", () => {
  it.each([
    ["Support desk", []],
    ["Tier 2 support", []],
    ["Finance & ops", []],
    ["Équipe conformité", []],
    [" Support", ["name"]],
    ["Support ", ["name"]],
    ["Support  desk", ["name"]],
    ["Support\tdesk", ["name"]],
    ["Support\u{a0}desk", ["name"]],
    ["Sup\u{200b}port", ["name"]],
    ["Support\u{202e}", ["name"]],
    ["Support\u{2066}desk\u{2069}", ["name"]],
    ["\u{feff}Support", ["name"]],
    ["Sup\u0007port", ["name"]],
    ["Cafe\u{301}", ["name"]],
  ] as const)("%j: %j", (name, expected) => {
    expect(nameProblems(name)).toEqual(expected);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(nameProblems("\u{1f600}".repeat(40))).toEqual([]);
    expect(nameProblems("\u{1f600}".repeat(41))).toEqual(["name"]);
  });
});

describe("names that read as a built-in role's (spec 02 §8.4)", () => {
  it.each([
    "Super admin",
    "Super Admin",
    "super_admin",
    "SUPERADMIN",
    "Super-Admins",
    "super admin.",
    "Super administrator",
    "Admin",
    "admins",
    "Admin's",
    "Admin 2",
    "Administrators",
    "ADMIN!",
    "Ádmin",
    "\u{410}dmin", // a Cyrillic A (U+0410)
    "Adm\u{456}n", // a Cyrillic i (U+0456)
    "\u{1d00}\u{1d05}\u{1d0d}\u{26a}\u{274}", // Latin small capitals
    "\u{ff21}\u{ff44}\u{ff4d}\u{ff49}\u{ff4e}", // full-width letters
  ])("%j reads as built-in in the dashboard", (name) => {
    expect(readsAsBuiltIn(dash, name)).toBe(true);
  });

  it.each(["Viewer", "Viewers", "compliance", "Operator", "OPERATORS", "Admin", "Administrator"])(
    "%j reads as built-in in Fin Admin",
    (name) => {
      expect(readsAsBuiltIn(staff, name)).toBe(true);
    },
  );

  it.each(["Support", "Admin support", "Billing admin", "Super", "Owner", "Finance", "Adm", "2"])(
    "%j does not read as built-in in the dashboard",
    (name) => {
      expect(readsAsBuiltIn(dash, name)).toBe(false);
    },
  );

  it("compares each realm only with its own built-ins", () => {
    expect(readsAsBuiltIn(dash, "Viewer")).toBe(false);
    expect(readsAsBuiltIn(staff, "Super admin")).toBe(false);
  });

  it("reads every look-alike letter as its Latin one", () => {
    expect(
      readingOf(
        "\u{430}\u{432}\u{435}\u{451}\u{43a}\u{43c}\u{43d}\u{43e}\u{440}\u{441}\u{442}\u{443}\u{445}\u{456}\u{457}\u{458}\u{455}\u{501}\u{51b}\u{51d}\u{4af}\u{261}",
      ),
    ).toBe("abeekmhopctyxiijsdqwyg");
    expect(
      readingOf(
        "\u{410}\u{412}\u{415}\u{41a}\u{41c}\u{41d}\u{41e}\u{420}\u{421}\u{422}\u{423}\u{425}",
      ),
    ).toBe("abekmhopctyx");
    expect(
      readingOf(
        "\u{3b1}\u{3b2}\u{3b5}\u{3b7}\u{3b9}\u{3ba}\u{3bd}\u{3bf}\u{3c1}\u{3c4}\u{3c5}\u{3c7}\u{3c9}",
      ),
    ).toBe("abenikvoptuxw");
    expect(readingOf("\u{131}")).toBe("i");
    expect(
      readingOf(
        "\u{1d00}\u{299}\u{1d04}\u{1d05}\u{1d07}\u{262}\u{29c}\u{26a}\u{1d0a}\u{1d0b}\u{29f}\u{1d0d}\u{274}\u{1d0f}\u{1d18}\u{280}\u{a731}\u{1d1b}\u{1d1c}\u{1d20}\u{1d21}\u{28f}\u{1d22}",
      ),
    ).toBe("abcdeghijklmnoprstuvwyz");
    expect(readsAsBuiltIn(staff, "\u{41e}\u{440}\u{435}r\u{430}t\u{43e}r")).toBe(true);
    expect(readsAsBuiltIn(staff, "\u{421}ompliance")).toBe(true);
  });

  it("reads a name as its letters", () => {
    expect(readingOf("Super-Admins 2!")).toBe("superadmin");
    expect(readingOf("Tier 2")).toBe("tier");
    expect(readingOf("")).toBe("");
  });
});

describe("the identity name rules, passed in", () => {
  const roleName = (name: string) => !/https?:|www\./.test(name);
  const roleDescription = (text: string) => !/\d{7,}/.test(text);
  const names = { roleName, roleDescription };

  it("refuse what names.ts refuses, as name or description", () => {
    const permissions = ["customers.read"];
    const check = (name: string, description: string) =>
      validateRole(anyDash, { name, description, permissions }, all(dash), { names });
    expect(check("www.example.com", "")).toEqual(["name"]);
    expect(check("Support", "Call 0000000")).toEqual(["description"]);
    expect(check("Support", "Helps customers.")).toEqual([]);
  });

  it("never run on an empty description, which is allowed", () => {
    let called = false;
    const watching = {
      roleName,
      roleDescription: () => {
        called = true;
        return false;
      },
    };
    const draft = { name: "Support", description: "", permissions: ["customers.read"] };
    expect(validateRole(anyDash, draft, all(dash), { names: watching })).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("validateRole over random drafts", () => {
  const runs = propertyRuns(800);
  for (const seed of propertySeeds()) {
    it(`reports exactly the permission rules a draft breaks (seed ${seed})`, () => {
      const rng = seeded(seed);
      for (const cat of [dash, staff] as Catalogue[]) {
        for (let run = 0; run < runs; run += 1) {
          const actorRole = rng.chance(0.3)
            ? ({ kind: "built_in", key: rng.pick(cat.builtIns).key } as const)
            : {
                kind: "custom" as const,
                id: `${cat.customRolePrefix}_${"0".repeat(26)}`,
                name: "Actor",
                description: "",
                permissions: rng.subset(cat.keys, 0.6),
              };
          const actorPerms = permissionsOf(cat, actorRole);
          const permissions = [
            ...rng.subset(cat.keys, rng.pick([0, 0.1, 0.3, 0.7])),
            ...(rng.chance(0.05) ? ["nope.read"] : []),
          ];
          const problems = validateRole(
            cat,
            { name: "Support desk", description: "", permissions },
            actorPerms,
          );
          const known = permissions.filter((k) => cat.keys.includes(k));
          const expected: RoleProblem[] = [];
          if (permissions.length === 0) expected.push("empty");
          if (known.some((k) => cat.restricted.includes(k))) expected.push("restricted");
          if (permissions.some((k) => !actorPerms.has(k))) expected.push("beyond");
          if (missingNeed(cat, known).length > 0) expected.push("missing_need");
          expect(problems, `${cat.realm}, seed ${seed}, run ${run}`).toEqual(expected);
          // A draft that passes never gives more than the editor, a restricted permission or an
          // unmet need.
          if (problems.length === 0) {
            for (const key of permissions) {
              expect(actorPerms.has(key)).toBe(true);
              expect(cat.restricted).not.toContain(key);
            }
          }
        }
      }
    });
  }
});
