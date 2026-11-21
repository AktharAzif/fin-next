// The role editor's name rules, what a name reads as, and a property over random drafts.
import { describe, expect, it } from "vitest";
import { dashboardCatalogue as dash } from "../catalogue/dashboard/index.ts";
import { staffCatalogue as staff } from "../catalogue/staff/index.ts";
import { propertyRuns, propertySeeds, seeded } from "../test-support/seeded.ts";
import { missingNeed } from "./permissions.ts";
import {
  LOOK_ALIKE_ROWS,
  normaliseRoleText,
  readingOf,
  readsAsBuiltIn,
  roleNameKey,
  validateRole,
} from "./role-editor.ts";
import { describePermissions, permissionsOf, summary } from "./roles.ts";
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

  // Characters that draw as nothing or as blank space, though Unicode does not file them all as
  // control or format characters: the Hangul fillers are letters, the variation selectors and the
  // combining grapheme joiner are marks, and the braille blank is a symbol.
  const invisible: [string, string][] = [
    ["U+3164 HANGUL FILLER", "\u{3164}"],
    ["U+115F HANGUL CHOSEONG FILLER", "\u{115f}"],
    ["U+1160 HANGUL JUNGSEONG FILLER", "\u{1160}"],
    ["U+FFA0 HALFWIDTH HANGUL FILLER", "\u{ffa0}"],
    ["U+034F COMBINING GRAPHEME JOINER", "\u{34f}"],
    ["U+FE0F VARIATION SELECTOR-16", "\u{fe0f}"],
    ["U+FE00 VARIATION SELECTOR-1", "\u{fe00}"],
    ["U+180B MONGOLIAN FREE VARIATION SELECTOR ONE", "\u{180b}"],
    ["U+17B4 KHMER VOWEL INHERENT AQ", "\u{17b4}"],
    ["U+2800 BRAILLE PATTERN BLANK", "\u{2800}"],
    ["U+1D159 MUSICAL SYMBOL NULL NOTEHEAD", "\u{1d159}"],
    ["U+16FE4 KHITAN SMALL SCRIPT FILLER", "\u{16fe4}"],
    ["U+E0041 TAG LATIN CAPITAL LETTER A", "\u{e0041}"],
  ];
  it.each(invisible)("refuses %s in a name, in either realm", (_what, char) => {
    for (const cat of [dash, staff] as Catalogue[]) {
      expect(nameProblems(`Support${char}`, cat)).toEqual(["name"]);
      expect(nameProblems(`Sup${char}port desk`, cat)).toEqual(["name"]);
      expect(nameProblems(char, cat)).toEqual(["name"]);
    }
  });

  it("refuses a name made only of blank characters", () => {
    expect(nameProblems("\u{3164}\u{3164}")).toEqual(["name"]);
    expect(nameProblems("\u{2800}")).toEqual(["name"]);
    expect(nameProblems("\u{115f}\u{1160}")).toEqual(["name"]);
  });

  it("runs the floor even when the identity rules are passed and accept everything", () => {
    const names = { roleName: () => true, roleDescription: () => true };
    const check = (name: string) =>
      validateRole(anyDash, { name, description: "", permissions: ["customers.read"] }, all(dash), {
        names,
      });
    expect(check(" Support")).toEqual(["name"]);
    expect(check("Sup\u{200b}port")).toEqual(["name"]);
    expect(check("Support\u{3164}")).toEqual(["name"]);
    expect(check("x".repeat(41))).toEqual(["name"]);
    expect(check("Support")).toEqual([]);
  });
});

describe("role descriptions", () => {
  const descriptionProblems = (description: string, cat: Catalogue = dash) =>
    validateRole(
      cat,
      { name: "Support", description, permissions: ["customers.read"] },
      all(cat),
    ).filter((p) => p === "description");

  it.each([
    ["an empty description", "", []],
    ["a plain sentence", "Helps customers with their accounts.", []],
    ["a zero-width space", "Helps\u{200b}customers", ["description"]],
    ["a bidirectional override", "Helps \u{202e}customers", ["description"]],
    ["a Hangul filler alone", "\u{3164}", ["description"]],
    ["braille blanks alone", "\u{2800}\u{2800}\u{2800}", ["description"]],
    ["a variation selector", "Helps customers \u{2764}\u{fe0f}", ["description"]],
    ["text that is not normalised", " Helps customers", ["description"]],
  ] as const)("%s: %j", (_what, description, expected) => {
    expect(descriptionProblems(description)).toEqual(expected);
    expect(descriptionProblems(description, staff)).toEqual(expected);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(descriptionProblems("\u{1f600}".repeat(120))).toEqual([]);
    expect(descriptionProblems("\u{1f600}".repeat(121))).toEqual(["description"]);
  });

  it("runs the floor even when the identity rules are passed and accept everything", () => {
    const names = { roleName: () => true, roleDescription: () => true };
    const draft = { name: "Support", description: "\u{3164}", permissions: ["customers.read"] };
    expect(validateRole(anyDash, draft, all(dash), { names })).toEqual(["description"]);
  });
});

describe("names already taken in the realm", () => {
  const taken = (name: string, takenNames: string[]) =>
    validateRole(anyDash, { name, description: "", permissions: ["customers.read"] }, all(dash), {
      takenNames,
    }).filter((p) => p === "name_taken");

  it.each([
    ["the same name", "Support desk", ["Support desk"]],
    ["another case", "support DESK", ["Support desk"]],
    ["a stored name with spaces round it", "support desk", [" Support  Desk "]],
    ["a Cyrillic o for the Latin one", "Supp\u{43e}rt desk", ["Support desk"]],
    ["full-width letters", "\u{ff33}upport desk", ["Support desk"]],
    ["a variation selector added", "Support desk\u{fe0f}", ["Support desk"]],
    ["a grapheme joiner added", "Support desk\u{34f}", ["Support desk"]],
    ["a Hangul filler added", "Support\u{3164}", ["Support"]],
    ["a Lisu S for the Latin one", "\u{a4e2}upport", ["Support"]],
    ["Lisu capitals", "\u{a4e2}\u{a4f4}\u{a4d1}\u{a4d1}\u{a4f3}\u{a4e3}\u{a4d4}", ["Support"]],
    ["a Coptic O", "Supp\u{2c9f}rt", ["Support"]],
    ["a Canadian syllabics P", "Su\u{146d}\u{146d}ort", ["Support"]],
    ["a letter drawn as a middle dot", "Support\u{a78f}", ["Support\u{b7}"]],
    // U+03F9 GREEK CAPITAL LUNATE SIGMA SYMBOL is drawn as C, though it folds to a sigma.
    ["a Greek lunate sigma for the C", "\u{3f9}ash desk", ["Cash desk"]],
    ["one of several", "Billing", ["Support", "Billing"]],
    // Right-to-left letters, in the order they are drawn: Arabic heh (o) and alef (l).
    ["right-to-left letters, drawn as the name", "Po\u{627}\u{647}", ["Pool"]],
    ["right-to-left letters, stored as the name", "Po\u{647}\u{627}", ["Pool"]],
    // Letters of one of Unicode's classes, read as the others are.
    ["a sharp s, drawn as β", "\u{df}illing", ["Billing"]],
    ["a kra, drawn as κ", "Ris\u{138}", ["Risk"]],
    ["a turned w, drawn as м", "Tea\u{28d}", ["Team"]],
    ["a Latin letter named for another", "Suppo\u{a7a7}t", ["Support"]],
  ])("is taken: %s", (_what, name, takenNames) => {
    expect(taken(name, takenNames)).toEqual(["name_taken"]);
  });

  it.each([
    ["another name", "Payments", ["Support desk", "Billing"]],
    ["another number", "Tier 1 support", ["Tier 2 support"]],
    ["an accent", "Café team", ["Cafe team"]],
    ["another word order", "Desk support", ["Support desk"]],
    ["no names taken", "Support desk", []],
    // Each order is compared with the same order: on one line the two are drawn apart.
    ["punctuation at the other end", "!Team", ["Team!"]],
  ])("is not taken: %s", (_what, name, takenNames) => {
    expect(taken(name, takenNames)).toEqual([]);
  });

  it("reads each name in one form", () => {
    expect(roleNameKey("Support Desk")).toBe(roleNameKey(" support  desk "));
    expect(roleNameKey("Supp\u{43e}rt")).toBe("support");
    expect(roleNameKey("Support\u{3164}\u{fe0f}")).toBe("support");
    expect(roleNameKey("Tier 1")).not.toBe(roleNameKey("Tier 2"));
    // As drawn on a left-to-right line: the right-to-left run "اه" is drawn "ها", "ol".
    expect(roleNameKey("Po\u{627}\u{647}")).toBe("pool");
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
    // Latin letters that read as others, all one script
    "\u{251}dmin", // U+0251 LATIN SMALL LETTER ALPHA
    "Super \u{251}dmin",
    "A\u{111}min", // U+0111 LATIN SMALL LETTER D WITH STROKE
    "ADMlN", // a lower-case L for the I
    "Adm|n",
    "Adm1n",
    "Super Adm1n",
    "Sup3r Admin",
    "4dmin",
    "@dmin",
    "Adm!n",
    "Adm\u{1c3}n", // U+01C3 LATIN LETTER RETROFLEX CLICK, drawn as "!"
    "Admin\u{1c3}",
    "Adrnin", // r and n drawn together as m
    "Aclmin", // c and l drawn together as d
    "Admin\u{2bc}s", // U+02BC MODIFIER LETTER APOSTROPHE
    "Admin\u{a78c}s", // U+A78C LATIN SMALL LETTER SALTILLO
    "Admin1",
    "Admin5",
    "Admin \u{662}", // an Arabic-Indic digit two, passed over as "2" is
    // Letters of other scripts that read as Latin ones
    "\u{13aa}dmin", // U+13AA CHEROKEE LETTER GO
    "\u{ab7a}dmin", // its small form
    "Admi\u{578}", // U+0578 ARMENIAN SMALL LETTER VO
    "\u{391}D\u{39c}\u{399}\u{39d}", // Greek capitals
    "Super a\u{3b4}min", // a Greek delta: one letter with no Latin reading
    "A\u{5d3}min", // a Hebrew dalet: the same
    // Invisible characters are not read at all
    "Admin\u{3164}",
    "Super admin\u{3164}",
    "Admin\u{115f}",
    "Super\u{ffa0}admin",
    "Ad\u{34f}min",
    "Admin\u{fe0f}",
    "Admin\u{2800}",
  ])("%j reads as built-in in the dashboard", (name) => {
    expect(readsAsBuiltIn(dash, name)).toBe(true);
  });

  it.each([
    "Viewer",
    "Viewers",
    "compliance",
    "Operator",
    "OPERATORS",
    "Admin",
    "Administrator",
    "0perator",
    "Operat0r",
    "0perat0r",
    "V1ewer",
    "Vievver", // v and v drawn together as w
    "Cornpliance",
    "Comp1iance",
    "Oper\u{251}tor",
    "\u{7c0}perator", // U+07C0 NKO DIGIT ZERO
    "Viewer\u{3164}",
    "Admin\u{3164}",
    "\u{13df}ompliance", // U+13DF CHEROKEE LETTER TLI
  ])("%j reads as built-in in Fin Admin", (name) => {
    expect(readsAsBuiltIn(staff, name)).toBe(true);
  });

  it.each([
    "Support",
    "Admin support",
    "Billing admin",
    "Super",
    "Owner",
    "Finance",
    "Adm",
    "2",
    "Admin team",
    "Super user",
    "Administration",
    "Admit",
    "Odmin",
    "Admin \u{7ba1}\u{7406}", // "Admin" and two CJK letters, which draw as letters
    "\u{7ba1}\u{7406}\u{8005}",
    "\u{30b7}\u{30b9}\u{30c6}\u{30e0}\u{7ba1}", // five letters of another script
    "\u{410}\u{434}\u{43c}\u{438}\u{43d}", // the Russian word, which does not draw as "Admin"
    "Tier 1 support",
    "A\u{3b4}\u{3bc}in", // two of five letters with no Latin reading: more than one in four
    "Adminss",
    "\u{3164}",
  ])("%j does not read as built-in in the dashboard", (name) => {
    expect(readsAsBuiltIn(dash, name)).toBe(false);
  });

  it.each([
    "Operations",
    "Reviewer",
    "Compliance team",
    "Viewers club",
    "\u{41e}\u{43f}\u{435}\u{440}\u{430}\u{442}\u{43e}\u{440}", // the Russian word
    "Super admin",
  ])("%j does not read as built-in in Fin Admin", (name) => {
    expect(readsAsBuiltIn(staff, name)).toBe(false);
  });

  // Letters of scripts drawn as Latin capitals (Lisu, Canadian syllabics, Coptic), letters drawn
  // as punctuation, and symbols drawn as letters: Unicode's confusables data reads each as Latin.
  it.each([
    "\u{a4ee}\u{a4d3}\u{a4df}\u{a4f2}\u{a4e0}", // Lisu letters drawn as "ADMIN"
    "\u{a4ee}\u{a4d3}min",
    "\u{a4ee}\u{a4d3}MIN",
    "\u{a4ee}dmi\u{a4e0}",
    "\u{15c5}\u{15ea}\u{15f0}I\u{144e}", // Canadian syllabics drawn as "ADMIN"
    "\u{2c80}\u{2c86}\u{2c98}\u{2c92}\u{2c9a}", // Coptic capitals drawn as "ADMIN"
    "\u{2c80}D\u{2c98}\u{2c92}\u{2c9a}",
    "Admin\u{a78f}", // U+A78F LATIN LETTER SINOLOGICAL DOT, drawn as "·"
    "Admin\u{1427}", // U+1427 CANADIAN SYLLABICS FINAL MIDDLE DOT
    "Admin\u{1428}", // U+1428 CANADIAN SYLLABICS FINAL SHORT HORIZONTAL STROKE
    "Admin\u{294}", // U+0294 LATIN LETTER GLOTTAL STOP, drawn as "?"
    "Admin\u{1c1}", // U+01C1 LATIN LETTER LATERAL CLICK, drawn as "‖"
    "Admin\u{1c2}", // U+01C2 LATIN LETTER ALVEOLAR CLICK, drawn as "‡"
    "Admin\u{4e00}", // a CJK letter drawn as a dash
    "\u{237a}dmin", // U+237A APL FUNCTIONAL SYMBOL ALPHA
    "Admi\u{2229}", // U+2229 INTERSECTION, drawn as an n
    "Adm\u{627}n", // an Arabic alef, drawn as an l
    "AcImin", // c and a capital I drawn together as d
    "Ac1min",
    "Ac|min",
    "Ac!min",
    "AcIministrator",
  ])("%j reads as built-in in both realms", (name) => {
    for (const cat of [dash, staff] as Catalogue[]) {
      expect(readsAsBuiltIn(cat, name), cat.realm).toBe(true);
      expect(nameProblems(name, cat), cat.realm).toContain("reads_as_built_in");
    }
  });

  it.each([
    "\u{a4e2}uper \u{a4ee}\u{a4d3}min",
    "Super \u{a4ee}\u{a4d3}\u{a4df}\u{a4f2}\u{a4e0}",
    "\u{a4e2}\u{a4f4}\u{a4d1}\u{a4f0}\u{a4e3} \u{a4ee}\u{a4d3}\u{a4df}\u{a4f2}\u{a4e0}", // "SUPER ADMIN"
    "Super\u{a78f}admin",
    "Super AcImin",
  ])("%j reads as built-in in the dashboard", (name) => {
    expect(readsAsBuiltIn(dash, name)).toBe(true);
  });

  it.each([
    "\u{a4da}\u{a4f3}\u{a4df}\u{a4d1}\u{a4e1}\u{a4f2}\u{a4ee}\u{a4e0}\u{a4da}\u{a4f0}", // "COMPLIANCE"
    "\u{a4f3}\u{a4d1}\u{a4f0}\u{a4e3}\u{a4ee}\u{a4d4}\u{a4f3}\u{a4e3}", // "OPERATOR"
    "\u{a4e6}\u{a4f2}\u{a4f0}\u{a4ea}\u{a4f0}\u{a4e3}", // "VIEWER"
    "VI\u{a4f0}\u{a4ea}ER",
    "OPE\u{a4e3}A\u{a4d4}O\u{a4e3}",
    "\u{a4da}\u{a4f3}\u{a4df}PLIANCE",
    "Vie\u{2228}\u{2228}er", // two logical-or signs drawn as w
    "\u{3f9}ompliance", // U+03F9 GREEK CAPITAL LUNATE SIGMA SYMBOL, drawn as C
  ])("%j reads as built-in in Fin Admin", (name) => {
    expect(readsAsBuiltIn(staff, name)).toBe(true);
  });

  // The built-in names in other scripts' words, which are not drawn as the Latin ones.
  it.each([
    "\u{ad00}\u{b9ac}\u{c790}", // Korean "admin"
    "\u{c6b4}\u{c601}\u{c790}", // Korean "operator"
    "\u{bdf0}\u{c5b4}", // Korean "viewer"
    "\u{cef4}\u{d50c}\u{b77c}\u{c774}\u{c5b8}\u{c2a4}", // Korean "compliance"
    "\u{645}\u{62f}\u{64a}\u{631}", // Arabic "manager"
    "\u{645}\u{634}\u{631}\u{641}", // Arabic "supervisor"
    "\u{5de}\u{5e0}\u{5d4}\u{5dc}", // Hebrew "manager"
    "\u{394}\u{3b9}\u{3b1}\u{3c7}\u{3b5}\u{3b9}\u{3c1}\u{3b9}\u{3c3}\u{3c4}\u{3ae}\u{3c2}", // Greek "administrator"
    "\u{3a7}\u{3b5}\u{3b9}\u{3c1}\u{3b9}\u{3c3}\u{3c4}\u{3ae}\u{3c2}", // Greek "operator"
    "\u{10d0}\u{10d3}\u{10db}\u{10d8}\u{10dc}\u{10d8}", // Georgian "admin"
    "\u{531}\u{564}\u{574}\u{56b}\u{576}", // Armenian "admin"
    "\u{935}\u{94d}\u{92f}\u{935}\u{938}\u{94d}\u{925}\u{93e}\u{92a}\u{915}", // Hindi "administrator"
    "\u{7ba1}\u{7406}\u{5458}", // Chinese "administrator"
    "\u{30aa}\u{30da}\u{30ec}\u{30fc}\u{30bf}\u{30fc}", // Japanese "operator"
    "Ac\u{3b4}min", // a letter of no Latin reading is never half of a pair
  ])("%j does not read as built-in in either realm", (name) => {
    for (const cat of [dash, staff] as Catalogue[]) {
      expect(readsAsBuiltIn(cat, name), cat.realm).toBe(false);
    }
  });

  // A sign compatibility folding turns into another drawn otherwise: U+FE31 PRESENTATION FORM FOR
  // VERTICAL EM DASH is drawn as l, though it folds to an em dash.
  it.each([
    ["Adm\u{fe31}n", [dash, staff]],
    ["Adm\u{fe31}nistrator", [dash, staff]],
    ["Super Adm\u{fe31}n", [dash]],
    ["Comp\u{fe31}iance", [staff]],
  ] as const)("%j, with a sign drawn as l, is refused", (name, cats) => {
    for (const cat of cats as readonly Catalogue[]) {
      expect(nameProblems(name, cat), cat.realm).toContain("reads_as_built_in");
    }
  });

  // Right-to-left letters are drawn in the opposite order from the one they are stored in: Arabic
  // heh (U+0647, drawn as o), N'Ko ta (U+07E0, t), Arabic alef (U+0627, l), Hebrew tet (U+05D8,
  // v). Both orders are refused: the one drawn as the built-in's name, and the one stored as it.
  it.each([
    ["Administra\u{647}\u{7e0}r", [dash, staff]], // drawn "AdministraTor"
    ["Administra\u{7e0}\u{647}r", [dash, staff]], // stored as "Administrator"
    ["Opera\u{647}\u{7e0}r", [staff]], // drawn "OperaTor"
    ["Opera\u{7e0}\u{647}r", [staff]],
    ["\u{627}\u{5d8}ewer", [staff]], // drawn "vlewer"
    ["\u{5d8}\u{627}ewer", [staff]],
  ] as const)("%j, read in the order it is drawn and stored, is refused", (name, cats) => {
    for (const cat of cats as readonly Catalogue[]) {
      expect(nameProblems(name, cat), cat.realm).toContain("reads_as_built_in");
    }
  });

  // A capital Unicode draws unlike its small letter reads as no Latin letter (Armenian Ա, though ա
  // is drawn as w; Greek Σ, though σ is drawn as o), so it may stand for the letter it is seen as.
  it.each([
    ["S\u{531}PER ADMIN", [dash]], // drawn "SUPER ADMIN"
    ["S\u{54d}PER ADMIN", [dash]], // U+054D, which Unicode draws as U
    ["SUP\u{3a3}R ADMIN", [dash]],
    ["OP\u{3a3}RATOR", [staff]],
    ["COMPLIANC\u{3a3}", [staff]],
  ] as const)("%j, with a capital drawn unlike its small letter, is refused", (name, cats) => {
    for (const cat of cats as readonly Catalogue[]) {
      expect(nameProblems(name, cat), cat.realm).toContain("reads_as_built_in");
    }
  });

  it("reads such a capital as no Latin letter, and its small letter as its own row says", () => {
    expect(readingOf("\u{531}")).toBe("\u{561}"); // Armenian Ա: no Latin reading
    expect(readingOf("\u{561}")).toBe("w"); // ա is drawn as w
    expect(readingOf("\u{393}")).toBe("\u{3b3}"); // Greek Γ: no Latin reading
    expect(readingOf("\u{3b3}")).toBe("y"); // γ is drawn as y
    expect(readingOf("\u{3a3}\u{3a9}")).toBe("\u{3c3}\u{3c9}"); // Σ and Ω
    expect(readingOf("\u{1b2}")).toBe("v"); // LATIN CAPITAL LETTER V WITH HOOK, by its name
  });

  // Every member of one of Unicode's classes reads as the others: c with bar and Ukrainian ie as ε
  // (e), Sinhala anusvara as o, and in name_taken below, sharp s as β, kra as κ, turned w as м.
  it.each([
    "Vi\u{a793}w\u{a793}r", // U+A793 LATIN SMALL LETTER C WITH BAR
    "\u{475}\u{456}\u{454}\u{51d}\u{454}\u{433}", // all Cyrillic, drawn "viewer"
    "Operat\u{d82}r", // U+0D82 SINHALA SIGN ANUSVARAYA
    "Operat\u{c02}r", // U+0C02 TELUGU SIGN ANUSVARA
  ])(
    "%j, with letters and marks of a class read as its others, is refused in Fin Admin",
    (name) => {
      expect(nameProblems(name, staff)).toContain("reads_as_built_in");
    },
  );

  // Latin letters named for another with a stroke, hook or curl, or a form of it, or a small capital.
  it.each([
    ["A\u{221}mi\u{235}", [dash, staff]], // d and n with curl
    ["\u{2c65}dmi\u{a7a5}", [dash, staff]], // a and n with a stroke
    ["A\u{221}mi\u{235}is\u{236}ra\u{236}or", [dash, staff]],
    ["\u{a7a9}u\u{a751}er A\u{221}min", [dash]],
    ["\u{2c71}ie\u{2c73}er", [staff]], // v with right hook, w with hook
    ["O\u{a751}e\u{a7a7}a\u{236}or", [staff]],
    ["\u{255}om\u{a753}\u{234}iance", [staff]],
    ["Vie\u{a7c3}e\u{a783}", [staff]], // ANGLICANA W, INSULAR R
    ["\u{1d8f}\u{1d81}min", [dash, staff]], // a and d with a hook
  ] as const)("%j, with Latin letters named for others, is refused", (name, cats) => {
    for (const cat of cats as readonly Catalogue[]) {
      expect(nameProblems(name, cat), cat.realm).toContain("reads_as_built_in");
    }
  });

  // A letter that is not an ASCII one may stand for one letter in four, whatever it reads as.
  it.each([
    ["Admi\u{43d}", [dash, staff]], // Cyrillic н, read as h, for the n
    ["Operato\u{44c}", [staff]], // Cyrillic ь, read as b, for the r
  ] as const)(
    "%j, with a letter of another script read as another letter, is refused",
    (name, cats) => {
      for (const cat of cats as readonly Catalogue[]) {
        expect(nameProblems(name, cat), cat.realm).toContain("reads_as_built_in");
      }
    },
  );

  it("is refused in the draft, with the name's other problems", () => {
    for (const cat of [dash, staff] as Catalogue[]) {
      expect(nameProblems("Admin\u{3164}", cat)).toEqual(["name", "reads_as_built_in"]);
      expect(nameProblems("\u{251}dmin", cat)).toEqual(["reads_as_built_in"]);
    }
    expect(nameProblems("Super admin\u{3164}")).toEqual(["name", "reads_as_built_in"]);
    expect(nameProblems("Oper\u{251}tor", staff)).toEqual(["reads_as_built_in"]);
  });

  it("reads no more than a name can hold, and leaves longer text to the length rule", () => {
    expect(readsAsBuiltIn(dash, `Admin${"!".repeat(400)}`)).toBe(false);
    expect(nameProblems(`Admin${"!".repeat(400)}`)).toEqual(["name"]);
    // Over the text limit, however little it reads as.
    expect(readsAsBuiltIn(dash, `Admin${" ".repeat(400)}`)).toBe(false);
    // Under the text limit, but folding to more glyphs than a name can hold.
    expect(readsAsBuiltIn(dash, `Admin${"\u{2473}".repeat(200)}`)).toBe(false);
    expect(readsAsBuiltIn(dash, `Admin${"\u{2473}".repeat(2)}`)).toBe(true);
  });

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
    expect(readingOf("Admin\u{3164}\u{fe0f}\u{2800}")).toBe("admin");
    expect(readingOf("A\u{5d3}min")).toBe("a\u{5d3}min"); // a letter of no Latin reading stays
  });

  it("reads the other look-alike letters as their Latin ones", () => {
    expect(readingOf("\u{251}\u{261}\u{131}\u{237}\u{269}\u{25b}\u{142}\u{111}\u{f0}\u{f8}")).toBe(
      "agijieldd" + "o",
    );
    expect(readingOf("\u{13aa}\u{13df}\u{13a0}\u{13ac}\u{13de}\u{13b7}\u{13e2}\u{13a1}")).toBe(
      "acdelmpr",
    );
    expect(readingOf("\u{13da}\u{13a2}\u{13d9}\u{13b3}\u{13a5}\u{13f4}")).toBe("stvwib");
    expect(readingOf("\u{578}\u{57d}\u{585}\u{56c}\u{548}\u{54d}\u{555}")).toBe("nuolnuo");
    expect(readingOf("\u{397}\u{39c}\u{39d}\u{3a5}\u{396}")).toBe("hmnyz"); // Greek capitals
    expect(readingOf("\u{3b7}\u{3bd}\u{3c5}")).toBe("nvu"); // and their lower-case forms
    expect(readingOf("\u{4bb}\u{4cf}\u{475}")).toBe("hlv");
  });

  it("holds each hand-made look-alike once, as one character and its reading", () => {
    const seen = new Set<string>();
    for (const row of LOOK_ALIKE_ROWS) {
      for (const entry of row.split(" ")) {
        const [char = "", reads = "", ...rest] = [...entry];
        expect(rest, `${row}: ${entry}`).toEqual([]);
        // A Latin letter, or the punctuation a letter is drawn as.
        expect(reads, `${row}: ${entry}`).toMatch(/^(?:[A-Za-z]|[\p{P}\p{S}])$/u);
        expect(char, `${row}: ${entry}`).not.toMatch(/^[A-Za-z]$/);
        expect(seen.has(char), `${entry} appears twice`).toBe(false);
        seen.add(char);
      }
    }
  });
});

describe("a custom role's summary", () => {
  const role = (description: string) =>
    ({
      kind: "custom",
      id: `rol_${"0".repeat(26)}`,
      name: "Support",
      description,
      permissions: ["customers.read"],
    }) as const;

  it("is its description, or the generated sentence when the description shows nothing", () => {
    expect(summary(dash, role("Helps customers."))).toBe("Helps customers.");
    const generated = describePermissions(dash, ["customers.read"]);
    for (const blank of ["", "   ", "\u{3164}", "\u{2800}\u{2800}", "\u{200b}", " \u{fe0f} "]) {
      expect(summary(dash, role(blank)), JSON.stringify(blank)).toBe(generated);
    }
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
