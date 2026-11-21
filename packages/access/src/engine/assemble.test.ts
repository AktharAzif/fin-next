// assembleCatalogue refuses every structurally broken catalogue (spec 02 §8.1: "built and
// checked"). Each case breaks one rule of a small valid catalogue.
import { describe, expect, it } from "vitest";
import { assembleCatalogue, CatalogueError } from "./assemble.ts";
import type { PermissionSpec } from "./types.ts";

interface Group {
  key: string;
  label: string;
  cant?: string;
  permissions: PermissionSpec[];
}
interface Role {
  key: string;
  label: string;
  summary: string;
  holds: "all" | string[];
}
interface Input {
  realm: string;
  groups: Group[];
  builtIns: Role[];
  topRoleKey: string;
  customRolePrefix: string;
  movePermission: string;
}

const perm = (key: string, overrides: Partial<PermissionSpec> = {}): PermissionSpec => ({
  key,
  label: `Label ${key}`,
  description: `Description of ${key}.`,
  needs: [],
  stepUp: "none",
  privileged: false,
  sandboxOnly: false,
  restricted: false,
  summary: { does: `do ${key}` },
  ...overrides,
});

function valid(): Input {
  return {
    realm: "dashboard",
    groups: [
      {
        key: "things",
        label: "Things",
        cant: "change things",
        permissions: [
          perm("things.read", { summary: { see: "things" } }),
          perm("things.edit", {
            needs: ["things.read"],
            summary: { does: "edit things", covers: "things.read" },
          }),
          perm("things.delete", { needs: ["things.edit"], restricted: true, privileged: true }),
        ],
      },
      { key: "other", label: "Other", permissions: [perm("other.use")] },
    ],
    builtIns: [
      { key: "owner", label: "Owner", summary: "Everything.", holds: "all" },
      { key: "editor", label: "Editor", summary: "Edits.", holds: ["things.read", "things.edit"] },
    ],
    topRoleKey: "owner",
    customRolePrefix: "tst",
    movePermission: "things.edit",
  };
}

const build = (input: Input) => assembleCatalogue(input as never);
const things = (i: Input) => i.groups[0] as Group;
const other = (i: Input) => i.groups[1] as Group;
const owner = (i: Input) => i.builtIns[0] as Role;
const editor = (i: Input) => i.builtIns[1] as Role;
const otherIs =
  (...permissions: PermissionSpec[]) =>
  (i: Input) => {
    other(i).permissions = permissions;
  };

describe("assembleCatalogue", () => {
  it("assembles a valid catalogue with its closure, dependents and restricted list", () => {
    const cat = build(valid()) as unknown as {
      keys: string[];
      closure: Record<string, string[]>;
      dependents: Record<string, string[]>;
      restricted: string[];
      groups: { key: string; cant?: string }[];
    };
    expect(cat.keys).toEqual(["things.read", "things.edit", "things.delete", "other.use"]);
    expect(cat.closure["things.delete"]).toEqual(["things.read", "things.edit"]);
    expect(cat.dependents["things.read"]).toEqual(["things.edit", "things.delete"]);
    expect(cat.restricted).toEqual(["things.delete"]);
    expect(cat.groups[0]?.cant).toBe("change things");
    expect("cant" in (cat.groups[1] ?? {})).toBe(false);
  });

  it("copies what it is given, so the caller's objects stay theirs", () => {
    const input = valid();
    const cat = build(input) as unknown as { builtIns: { holds: "all" | string[] }[] };
    (editor(input).holds as string[]).push("other.use");
    expect(Object.isFrozen(editor(input))).toBe(false);
    expect(cat.builtIns[1]?.holds).toEqual(["things.read", "things.edit"]);
  });

  const setInput =
    <K extends keyof Input>(key: K, value: Input[K]) =>
    (i: Input) => {
      i[key] = value;
    };
  const setGroup =
    <K extends keyof Group>(pick: (i: Input) => Group, key: K, value: Group[K]) =>
    (i: Input) => {
      pick(i)[key] = value;
    };
  const setRole =
    <K extends keyof Role>(pick: (i: Input) => Role, key: K, value: Role[K]) =>
    (i: Input) => {
      pick(i)[key] = value;
    };

  // Each case breaks one rule, and the refusal must name that rule (not a later check's).
  // biome-ignore format: one rule per line
  const broken: [string, (input: Input) => void, string][] = [
    ["an unknown realm", setInput("realm", "elsewhere"), "the realm must be dashboard or staff"],
    ["a malformed custom role prefix", setInput("customRolePrefix", "TOOLONG"), "the custom role prefix must be three lower-case letters"],
    ["no groups", setInput("groups", []), "there are no groups"],
    ["a malformed group key", setGroup(other, "key", "Other Group"), 'the group key "Other Group" is malformed'],
    ["a repeated group", setGroup(other, "key", "things"), 'the group "things" appears twice'],
    ["a group without a label", setGroup(other, "label", " "), 'the group "other" has no label'],
    ["a group label of blank characters", setGroup(other, "label", "\u{3164}"), 'the group "other" has no label'],
    ["a group label holding an invisible character", setGroup(other, "label", "Oth\u{200b}er"), 'the group "other" has no label'],
    ["a group label another group has", setGroup(other, "label", "Things"), 'the group "other" repeats the label of "things"'],
    ["a group label another has, in another case", setGroup(other, "label", "THINGS"), 'the group "other" repeats the label of "things"'],
    ["an empty can't phrase", setGroup(things, "cant", ""), `the group "things" has an empty "can't" phrase`],
    ["an empty group", otherIs(), 'the group "other" has no permissions'],
    ["a malformed permission key", otherIs(perm("Other.Use")), 'the permission key "Other.Use" is malformed'],
    ["a permission twice", otherIs(perm("things.read")), 'the permission "things.read" appears twice'],
    ["a permission key another has in another case", otherIs(perm("thingS.read")), 'the permission "thingS.read" differs from "things.read" only in case'],
    ["a permission key ending in an underscore", otherIs(perm("other.use_")), 'the permission key "other.use_" is malformed'],
    ["a permission key with two underscores together", otherIs(perm("other.use__all")), 'the permission key "other.use__all" is malformed'],
    ["a permission without a label", otherIs(perm("other.use", { label: "" })), 'the permission "other.use" has no label'],
    ["a permission label another permission has", otherIs(perm("other.use", { label: "Label things.read" })), 'the permission "other.use" repeats the label of "things.read"'],
    ["a permission label another has, in another case", otherIs(perm("other.use", { label: "LABEL THINGS.EDIT" })), 'the permission "other.use" repeats the label of "things.edit"'],
    ["a permission without a description", otherIs(perm("other.use", { description: "  " })), 'the permission "other.use" has no description'],
    ["an unknown step-up kind", otherIs(perm("other.use", { stepUp: "sometimes" as never })), "has an unknown step-up kind"],
    ["a flag that is not true or false", otherIs(perm("other.use", { restricted: "yes" as never })), '"restricted" must be true or false'],
    ["a privileged permission in Fin Admin", setInput("realm", "staff"), 'the permission "things.delete" is marked privileged'],
    ["a permission that needs itself", otherIs(perm("other.use", { needs: ["other.use"] })), 'the permission "other.use" needs itself'],
    ["a need no fragment defines", otherIs(perm("other.use", { needs: ["other.read"] })), 'needs "other.read", which no fragment defines'],
    ["a need named twice", otherIs(perm("other.use", { needs: ["things.read", "things.read"] })), 'names the need "things.read" twice'],
    ["an empty summary phrase", otherIs(perm("other.use", { summary: { does: "" } })), 'the permission "other.use" has an empty summary phrase'],
    ["an empty see phrase", otherIs(perm("other.use", { summary: { see: " " } })), 'the permission "other.use" has an empty summary phrase'],
    ["a cycle of needs", otherIs(perm("other.use", { needs: ["other.more"] }), perm("other.more", { needs: ["other.use"] })), "the needs form a cycle: other.use → other.more → other.use"],
    ["a summary cover it does not need", otherIs(perm("other.use", { summary: { does: "use", covers: "things.read" } })), '"other.use" covers "things.read", which it does not need'],
    ["a summary cover of an unknown permission", otherIs(perm("other.use", { summary: { does: "use", covers: "other.read" } })), '"other.use" covers "other.read", which is unknown'],
    ["a summary cover of a permission that is not a see", otherIs(perm("other.use", { needs: ["things.edit"], summary: { does: "use", covers: "things.edit" } })), 'which is not a "see" permission'],
    ["no built-in roles", setInput("builtIns", []), "there are no built-in roles"],
    ["a malformed built-in key", setRole(editor, "key", "Editor"), 'the built-in role "Editor" has a malformed key'],
    ["a built-in key shaped like a custom role ID", setRole(editor, "key", "tst_editor"), "has a key that reads as a custom role's ID"],
    ["a built-in role twice", setRole(editor, "key", "owner"), 'the built-in role "owner" appears twice'],
    ["a built-in role that repeats another's label", setRole(editor, "label", "OWNER"), "repeats another role's label"],
    ["a built-in role without a label", setRole(editor, "label", ""), 'the built-in role "editor" has no label'],
    ["a built-in role label with a variation selector", setRole(editor, "label", "Editor\u{fe0f}"), 'the built-in role "editor" has no label'],
    ["a permission description of braille blanks", otherIs(perm("other.use", { description: "\u{2800}\u{2800}" })), 'the permission "other.use" has no description'],
    ["a built-in role without a summary", setRole(editor, "summary", ""), 'the built-in role "editor" has no summary'],
    ["a built-in role that holds nothing", setRole(editor, "holds", []), 'the built-in role "editor" holds nothing'],
    ["a built-in role holding an unknown permission", setRole(editor, "holds", ["things.read", "nope.read"]), 'holds "nope.read", which no fragment defines'],
    ["a built-in role holding a permission twice", setRole(editor, "holds", ["things.read", "things.read"]), 'holds "things.read" twice'],
    ["a built-in role missing a need", setRole(editor, "holds", ["things.edit"]), 'holds "things.edit" but not its need "things.read"'],
    ["a lesser built-in role holding a restricted permission", setRole(editor, "holds", ["things.read", "things.edit", "things.delete"]), 'holds "things.delete", which only the top role may hold'],
    ["a top role that is not a built-in", setInput("topRoleKey", "nobody"), 'the top role "nobody" is not a built-in role'],
    ["a top role that does not hold everything", setRole(owner, "holds", ["things.read", "things.edit", "things.delete"]), 'the top role "owner" must hold every permission'],
    ["an unknown move permission", setInput("movePermission", "things.move"), 'the move permission "things.move" is not in the catalogue'],
  ];

  it.each(broken)("refuses %s", (_what, breakIt, message) => {
    const input = valid();
    expect(() => build(input)).not.toThrow();
    breakIt(input);
    expect(() => build(input)).toThrow(CatalogueError);
    expect(() => build(input)).toThrow(message);
  });

  it("names the realm and the rule in its refusal", () => {
    const input = valid();
    input.movePermission = "things.move";
    expect(() => build(input)).toThrow(/^dashboard catalogue: the move permission "things.move"/);
    const error = (() => {
      try {
        build(input);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("CatalogueError");
  });
});
