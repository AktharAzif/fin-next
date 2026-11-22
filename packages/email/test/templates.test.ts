// T08-20, T08-23, T-SAT-15, T-SAT-41: every template renders; no typed value reaches a subject,
// heading or preview; every class sends from its subdomain; at most one link and no image; a value
// Fin builds refuses a secret and a name or device label hides one, so a planted secret never
// reaches a message.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  describe as digestLine,
  findTemplate,
  grantRows,
  rolesFor,
  TEMPLATES,
} from "../src/catalogue.ts";
import { CLASS_RULES, defineTemplate, TemplateDefinitionError } from "../src/classes.ts";
import { checkHeaders, finHeaders } from "../src/headers.ts";
import { HIDDEN_VALUE, param } from "../src/params.ts";
import { RenderError, renderTemplate } from "../src/render.ts";

const LINKS = {
  console: "https://console.example.com",
  admin: "https://staff.example.com",
  verify: "https://onboard.example.com",
};
const CONTEXT = { recipient: "person@example.com", environment: "staging", describe: digestLine };

/** The display-value keys a sentinel can replace (typed or variable text). */
const TYPED_KEYS = [
  "personName",
  "orgName",
  "roleLabel",
  "previousRoleLabel",
  "device",
  "changedBy",
];
const SENTINEL = "Zebulon Quartz";

function withSentinels(sample: Record<string, unknown>): Record<string, unknown> {
  const out = { ...sample };
  for (const key of TYPED_KEYS) if (key in out) out[key] = SENTINEL;
  return out;
}

describe("the catalogue", () => {
  it("has unique ids and every template declares a known class and a matching subdomain", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(CLASS_RULES[t.class].subdomain).toBe(t.subdomain);
      expect(t.priority).toBe(CLASS_RULES[t.class].priority);
      expect(findTemplate(t.id)).toBe(t);
    }
  });

  it("gives every security template its digest line, and codes a life", () => {
    for (const t of TEMPLATES) {
      if (t.class === "security") expect(t.digestLine, t.id).toBeTypeOf("string");
      if (t.class === "code") expect(t.codeTtlMs, t.id).toBeGreaterThan(0);
    }
  });

  it("allows each role exactly the folders of spec 08 §4.4", () => {
    for (const t of TEMPLATES) {
      const roles = rolesFor(t);
      if (["identity", "orgs"].includes(t.area)) expect(roles).toEqual(["fin_console"]);
      if (t.area === "staff") expect(roles).toEqual(["fin_admin"]);
      if (t.area === "ops") expect(roles).toEqual(["fin_worker"]);
    }
    const rows = grantRows();
    expect(rows.find((r) => r.template === "ops/delivery-check")).toMatchObject({
      role: "fin_worker",
      category: "ops",
      priority: 4,
    });
    expect(rows.filter((r) => r.role === "fin_payments")).toEqual([]);
  });

  it("names the bypass templates of spec 08 §4.3", () => {
    const bypass = TEMPLATES.filter((t) => t.class === "security" && t.bypasses(t.sample)).map(
      (t) => t.id,
    );
    expect(bypass.sort()).toEqual(
      [
        "ops/security-digest",
        "orgs/member-joined",
        "orgs/member-removed",
        "orgs/member-role-changed",
        "orgs/role-permissions-changed",
        "staff/staff-access-changed",
        "staff/staff-factors-reset",
        "staff/staff-switch-changed",
      ].sort(),
    );
  });
});

describe.each(TEMPLATES.map((t) => [t.id, t] as const))("%s", (_id, template) => {
  const sample = template.sample as Record<string, unknown>;

  it("renders its sample in both parts with Fin's footer", () => {
    const r = renderTemplate(template, sample, CONTEXT, LINKS);
    expect(r.subject.length).toBeGreaterThan(5);
    expect(r.text).toContain(r.heading);
    expect(r.html).toContain("<!doctype html>");
    expect(r.text).toContain("Replies to it are not read.");
  });

  it("keeps typed values out of the subject, heading and preview, and escapes them in the body", () => {
    const params = withSentinels(sample);
    const r = renderTemplate(template, params, CONTEXT, LINKS);
    for (const fixed of [r.subject, r.heading, r.preview]) {
      expect(fixed).not.toContain(SENTINEL);
      expect(fixed).not.toContain(CONTEXT.recipient);
      expect(fixed).not.toMatch(/\d{8}/u);
    }
    if (TYPED_KEYS.some((k) => k in sample)) expect(r.text).toContain(SENTINEL);
  });

  it("has no image, at most one link, and links only to a configured https origin", () => {
    const r = renderTemplate(template, sample, CONTEXT, LINKS);
    expect(r.html).not.toMatch(/<img|background-image|url\(/iu);
    const links = r.html.match(/<a /gu) ?? [];
    expect(links.length).toBeLessThanOrEqual(1);
    for (const href of r.html.matchAll(/href="([^"]+)"/gu)) {
      expect(href[1]).toMatch(/^https:\/\/(console|staff|onboard)\.example\.com\//u);
    }
  });

  it("sends only headers Cloudflare allows, with Fin's three and no List-Unsubscribe", () => {
    const headers = finHeaders(template.class, "entity-ref-1");
    expect(() => checkHeaders(headers)).not.toThrow();
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("list-unsubscribe");
    expect(headers["X-Fin-Category"]).toBe(template.class);
  });

  it("refuses or hides a planted secret in every string parameter, so it never reaches a message", () => {
    const planted = [
      ["fin", "live", "sk", "0123456789ABCDEFGHIJabcdefghijklmnopqrstuvwxyz01"].join("_"),
      ["whsec", "abcdefghijklmnopqrstuvwxyz012345"].join("_"),
      ["ABCD", "EFGH", "JK3M", "NPQR"].join("-"),
      ["a1B2c", "D3e4F"].join("-"),
      ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJl"].join("."),
    ];
    // A name field hides a secret, a code included, and never refuses the notice (and so the
    // action); every other string refuses it.
    const names = new Set(["personName", "orgName", "roleLabel", "previousRoleLabel", "changedBy"]);
    for (const key of Object.keys(sample)) {
      if (typeof sample[key] !== "string") continue;
      for (const secret of planted) {
        const params = { ...sample, [key]: secret };
        let text = "";
        try {
          const r = renderTemplate(template, params, CONTEXT, LINKS);
          text = `${r.subject}\n${r.text}\n${r.html}`;
        } catch (error) {
          expect(error).toBeInstanceOf(RenderError);
          expect(names.has(key), `${template.id}.${key} refused`).toBe(false);
          continue;
        }
        expect(text, `${template.id}.${key}`).not.toContain(secret);
      }
    }
  });

  it("refuses unknown parameters", () => {
    expect(() => renderTemplate(template, { ...sample, extra: "x" }, CONTEXT, LINKS)).toThrow(
      RenderError,
    );
  });
});

describe("code templates", () => {
  it("put the address and the code only in the link's fragment", () => {
    const t = findTemplate("identity/sign-in-code");
    if (t === undefined) throw new Error("missing");
    const r = renderTemplate(
      t,
      { code: "12345678" },
      { ...CONTEXT, recipient: "a+b@example.com" },
      LINKS,
    );
    expect(r.html).toContain(
      'href="https://console.example.com/sign-in/code#e&#61;a%2Bb%40example.com&amp;c&#61;12345678"',
    );
    expect(r.text).toContain("Your code: 12345678");
  });

  it("refuse a code that is not 8 digits", () => {
    const t = findTemplate("staff/staff-sign-in-code");
    if (t === undefined) throw new Error("missing");
    expect(() => renderTemplate(t, { code: "1234567" }, CONTEXT, LINKS)).toThrow(RenderError);
  });
});

describe("rendering", () => {
  it("escapes typed values in the HTML and flattens them in the text", () => {
    const t = findTemplate("orgs/member-joined");
    if (t === undefined) throw new Error("missing");
    const r = renderTemplate(
      t,
      { ...(t.sample as object), orgName: `Acme <b>"Pay"</b> & Co` },
      CONTEXT,
      LINKS,
    );
    expect(r.html).toContain("Acme &lt;b&gt;&quot;Pay&quot;&lt;/b&gt; &amp; Co");
    expect(r.html).not.toContain("<b>");
  });

  it("hides typed text that holds control or bidirectional characters, never rendering it", () => {
    const t = findTemplate("orgs/member-joined");
    if (t === undefined) throw new Error("missing");
    const rlo = String.fromCodePoint(0x202e);
    for (const orgName of [`Acme${rlo}moc.live`, "Acme\nVisit us"]) {
      const r = renderTemplate(t, { ...(t.sample as object), orgName }, CONTEXT, LINKS);
      const all = `${r.subject}\n${r.text}\n${r.html}`;
      expect(all).not.toContain(rlo);
      expect(all).not.toContain("moc.live");
      expect(all).not.toContain("Visit us");
      expect(r.text).toContain(HIDDEN_VALUE);
    }
  });

  it("hides a device label that holds a secret shape, and still renders the notice", () => {
    for (const id of [
      "identity/new-sign-in",
      "identity/session-ended",
      "identity/sign-in-methods-changed",
      "staff/staff-new-sign-in",
    ]) {
      const t = findTemplate(id);
      if (t === undefined) throw new Error("missing");
      const run = ["Abcdefgh", "12345678", "Ijkl"].join("");
      const device = `Browser ${run} on macOS`;
      const r = renderTemplate(t, { ...(t.sample as object), device }, CONTEXT, LINKS);
      expect(`${r.text}\n${r.html}`, id).not.toContain(run);
      expect(r.text, id).toContain(HIDDEN_VALUE);
    }
  });

  it("fails a link whose host has no configured origin, as configuration", () => {
    const t = findTemplate("identity/new-sign-in");
    if (t === undefined) throw new Error("missing");
    try {
      renderTemplate(t, t.sample, CONTEXT, { admin: LINKS.admin });
      expect.unreachable();
    } catch (error) {
      expect((error as RenderError).code).toBe("link_origin_missing");
    }
  });

  it("names refused fields, never their values", () => {
    const t = findTemplate("identity/new-sign-in");
    if (t === undefined) throw new Error("missing");
    try {
      renderTemplate(t, { ...(t.sample as object), time: "secret@example.com" }, CONTEXT, LINKS);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("time");
      expect((error as Error).message).not.toContain("example.com");
    }
  });

  it("writes the digest's fixed lines from the catalogue", () => {
    const t = findTemplate("ops/security-digest");
    if (t === undefined) throw new Error("missing");
    const r = renderTemplate(t, t.sample, CONTEXT, LINKS);
    expect(r.text).toContain("There were 3 changes to your Fin account or team in the last hour.");
    expect(r.text).toContain("Changes to how you sign in: 2");
    expect(r.text).toContain("Sign-ins from new browsers: 1");
    expect(r.html).toContain("https://console.example.com/account/security");
  });
});

describe("defineTemplate", () => {
  const base = {
    name: "probe",
    area: "ops" as const,
    realm: "ops" as const,
    params: z.strictObject({ code: param.code }),
    sample: { code: "12345678" },
    render: () => ({ subject: "s", heading: "h", preview: "p", paragraphs: [] }),
  };

  it("refuses a class sent from the wrong subdomain", () => {
    expect(() =>
      defineTemplate({
        ...base,
        class: "notice",
        subdomain: "auth",
        secretBearing: false,
        bypassLimits: false,
      }),
    ).toThrow(TemplateDefinitionError);
  });

  it("refuses a code template without a life, a security one without a digest line, and a bypass outside security", () => {
    expect(() =>
      defineTemplate({
        ...base,
        class: "code",
        subdomain: "auth",
        secretBearing: true,
        bypassLimits: false,
      }),
    ).toThrow(TemplateDefinitionError);
    expect(() =>
      defineTemplate({
        ...base,
        class: "security",
        subdomain: "auth",
        secretBearing: false,
        bypassLimits: false,
      }),
    ).toThrow(TemplateDefinitionError);
    expect(() =>
      defineTemplate({
        ...base,
        class: "ops",
        subdomain: "auth",
        secretBearing: false,
        bypassLimits: true,
      }),
    ).toThrow(TemplateDefinitionError);
  });
});
