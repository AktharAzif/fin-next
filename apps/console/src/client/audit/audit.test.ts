import { describe, expect, it } from "vitest";
import type { AuditRow } from "../api/contracts/audit.ts";
import { auditQuery, emptyKind, objectChip, readAuditSearch } from "./filters.ts";
import { actorName, categoryLabel, describe as sentence, sentenceText, verifiedLabel } from "./sentences.ts";

function row(event: string, extra: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "aud_1",
    event,
    at: "2026-11-20T14:05:00Z",
    actor: { kind: "user", id: "usr_maya", name: "Maya Rivera", email: "maya@example.com" },
    ...extra,
  } as AuditRow;
}

describe("the audit log's sentences (spec 02 §14.5)", () => {
  it("names the actor and the object by their current labels", () => {
    const changed = row("member.role_changed", {
      target: { id: "mem_1", label: "Priya Shah" },
      metadata: { fromRole: "admin", toRole: "super_admin" },
    });
    expect(sentenceText(sentence(changed))).toBe(
      "Maya Rivera changed the role of Priya Shah to Super admin",
    );
  });

  it("names a custom role from the row's refs", () => {
    const changed = row("member.role_changed", {
      target: { id: "mem_1", label: "Priya Shah" },
      refs: [{ id: "rol_dev", label: "Developer" }],
      metadata: { toRole: "rol_dev" },
    });
    expect(sentence(changed).tail).toBe(" to Developer");
  });

  it("draws an object that no longer exists by its ID, in mono", () => {
    const removed = row("passkey.removed", { target: { id: "pky_1", label: null } });
    expect(sentence(removed)).toMatchObject({ object: "pky_1", mono: true });
  });

  it("says You for the viewer's own rows, and Fin for the system", () => {
    expect(actorName(row("session.created"), "usr_maya")).toBe("You");
    expect(actorName(row("x", { actor: { kind: "system" } }))).toBe("Fin");
    expect(actorName(row("x", { actor: { kind: "user", name: null, email: "a@example.com" } }))).toBe(
      "a@example.com",
    );
  });

  it("counts the backup codes left, and reads an unknown event by its name", () => {
    expect(sentenceText(sentence(row("backup_code.used", { metadata: { remaining: 8 } })))).toBe(
      "Maya Rivera used a backup code, 8 left",
    );
    expect(sentence(row("new.thing_done")).verb).toBe("new thing done");
  });

  it("labels the verification chip and the type pill", () => {
    expect(verifiedLabel("totp")).toBe("Authenticator");
    expect(verifiedLabel("email_otp")).toBe("Email code");
    expect(verifiedLabel(null)).toBeNull();
    expect(verifiedLabel("unknown")).toBeNull();
    expect(categoryLabel("sign_in")).toBe("Sign-ins");
  });
});

describe("the audit log's filters (spec 02 §15.2.1)", () => {
  it("keeps only what it knows from the URL", () => {
    expect(
      readAuditSearch({
        q: " priya ",
        type: "team",
        range: "7d",
        page: "2",
        target: "mem_1",
        targetKind: "role",
        view: "aud_9",
        other: "x",
      }),
    ).toEqual({ q: " priya ", type: "team", range: "7d", page: 2, target: "mem_1", targetKind: "role", view: "aud_9" });
    expect(readAuditSearch({ type: "money", range: "1y", page: "0", target: "../x", view: "x" })).toEqual({});
  });

  it("asks the API for the page's filters, 30 days by default", () => {
    expect(auditQuery({}, "Europe/London")).toEqual({ range: "30d", tz: "Europe/London", page: 1, size: 25 });
    expect(auditQuery({ target: "rol_1", view: "aud_1" }, "UTC")).toMatchObject({ target: "rol_1" });
    expect(auditQuery({ target: "rol_1", view: "aud_1" }, "UTC")).not.toHaveProperty("view");
  });

  it("picks the empty state: no match, an empty range, or nothing ever", () => {
    expect(emptyKind({ q: "zoe" })).toBe("noMatch");
    expect(emptyKind({ target: "mem_1" })).toBe("noMatch");
    expect(emptyKind({})).toBe("range");
    expect(emptyKind({ range: "all" })).toBe("ever");
  });

  it("names the one object in the chip, with its current label when the API gave one", () => {
    expect(objectChip({ target: "mem_1" }, "Priya Shah")).toBe("Priya Shah");
    expect(objectChip({ target: "mem_1" }, null)).toBe("mem_1");
    expect(objectChip({ targetKind: "role" }, null)).toBe("Roles");
    expect(objectChip({}, "x")).toBeNull();
  });
});
