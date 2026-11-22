// AdminAudit's URL against the route that answers it (spec 06 S6-03; spec 02 §14.3): whatever a
// hand-edited or shared link holds, what the screen's URL reader keeps is a query the route's own
// schema takes, so the screen never sends one it refuses and draws that as a fault on our side.
// The two halves are checked together here, so neither can drift from the other unseen.
import { describe, expect, it } from "vitest";
import { apiQuery, readAuditSearch } from "../client/routes/audit/-audit/search.ts";
import { auditEntryParams, auditQuery } from "./policy/audit.ts";

const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
/** A real-shaped ID: the prefix and 26 characters of lower-case Crockford base32. */
const id = (prefix: string, n: number) =>
  `${prefix}_01jd${Array.from({ length: 22 }, (_, i) => crockford[(n * 7 + i) % 32]).join("")}`;
const many = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, n) => id(prefix, n + 1)).join(",");
const letters = "abcdefghijklmnopqrstuvwxyz";
/** The `n`th of distinct event names in the API's shape, each `length` characters long. */
const longEvent = (n: number, length: number) =>
  `staff.${letters[Math.floor(n / 26) % 26]}${letters[n % 26]}${"x".repeat(length - 8)}`;

/** Links a person could hand-edit or be sent: each value at, past or beside what the API takes. */
const LINKS: Record<string, unknown>[] = [
  {},
  { actor: "stf_aaaaaaaa" },
  { actor: `${id("stf", 1)},stf_${"u".repeat(26)}` },
  { actor: `stf_${"i".repeat(26)},${id("stf", 2)},stf_01JD${"0".repeat(22)}` },
  { actor: many("stf", 25) },
  { org: `org_${"l".repeat(26)},${id("org", 3)}` },
  { org: many("org", 21) },
  { actor: `${id("stf", 1)},,${id("stf", 1)}`, org: "," },
  { action: "staff.role_changed,DROP TABLE,staff..x,Staff.signed_in" },
  { action: Array.from({ length: 60 }, (_, n) => longEvent(n, 12)).join(",") },
  // Fewer than 50 names, but more than the 2,000 characters a list may run to.
  { action: Array.from({ length: 30 }, (_, n) => longEvent(n, 90)).join(",") },
  { action: longEvent(0, 2_100) },
  { action: `${longEvent(1, 1_990)},staff.signed_in` },
  { date: "7d", from: "2026-11-01", to: "2026-11-02" },
  { from: "2026-11-21", to: "2026-11-01" },
  { from: "2026-02-30", to: "soon" },
  { cursor: id("aud", 1), before: id("aud", 2) },
  { cursor: "aud_0000", before: `aud_${"z".repeat(26)}` },
  { show: "everything", date: "yesterday", view: "aud_x" },
  { show: "mine", actor: many("stf", 3), action: "switch.set", org: id("org", 9), date: "month" },
];

describe("a hand-edited AdminAudit link", () => {
  it.each(LINKS.map((link) => [JSON.stringify(link).slice(0, 80), link] as const))(
    "is read into a query the route takes: %s",
    (_label, link) => {
      const sent = apiQuery(readAuditSearch(link));
      const parsed = auditQuery.safeParse(
        Object.fromEntries(Object.entries(sent).map(([key, value]) => [key, String(value)])),
      );
      expect(parsed.error?.issues ?? []).toEqual([]);
    },
  );

  it("keeps as many list items as the route takes, in their order, and no more", () => {
    const actors = readAuditSearch({ actor: many("stf", 25) }).actor?.split(",") ?? [];
    expect(actors).toEqual(many("stf", 20).split(","));
    const short = Array.from({ length: 60 }, (_, n) => longEvent(n, 12));
    expect(readAuditSearch({ action: short.join(",") }).action).toBe(short.slice(0, 50).join(","));
    const names = Array.from({ length: 30 }, (_, n) => longEvent(n, 90));
    const kept = readAuditSearch({ action: names.join(",") }).action ?? "";
    expect(kept.length).toBeLessThanOrEqual(2_000);
    // Whole names from the start, as many as fit.
    expect(kept.split(",")).toEqual(names.slice(0, kept.split(",").length));
    expect(kept.split(",").length).toBe(21);
  });

  it("opens an entry only by an ID the route takes", () => {
    for (const view of [id("aud", 1), "aud_x", `aud_${"u".repeat(26)}`, `aud_${"0".repeat(27)}`]) {
      const kept = readAuditSearch({ view }).view;
      if (kept !== undefined) {
        expect(auditEntryParams.safeParse({ eventId: kept }).success).toBe(true);
      }
    }
    expect(readAuditSearch({ view: id("aud", 1) }).view).toBe(id("aud", 1));
  });
});
