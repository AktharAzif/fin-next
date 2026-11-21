// AdminAudit's logic and static parts (spec 02 §14.5; spec 06 §7.2, S6-03): the URL's search as the
// route reads it and as the API is asked, the moves between searches (a filter drops the cursor
// and the open entry, Clear filters keeps the view), the empty states each search draws, the words
// for every staff-scope event and for reasons and changes, the UTC times, the loader's three
// outcomes, the contract, and the skeleton and the drawer's details.
import type { StaffViewer } from "@fin/app-contracts";
import { ApiError } from "@fin/frame";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EntryDetails } from "./AuditDrawer.tsx";
import { AuditSkeleton, rowLabel, shortId, totalLine } from "./AuditPage.tsx";
import { type AuditEntry, auditPageAnswer, getAuditEntry, listAudit } from "./contract.ts";
import { dateLabel, filterChips, listLink, personLabel } from "./filters.tsx";
import { formatDay, formatWhen, formatWhenLong } from "./format.ts";
import { loadAudit } from "./load.ts";
import {
  type AuditSearch,
  apiQuery,
  emptyKind,
  hrefOf,
  listDeps,
  paged,
  readAuditSearch,
  toggled,
  withFilter,
  withoutFilters,
} from "./search.ts";
import {
  ACTION_GROUPS,
  changesOf,
  humanise,
  reasonOf,
  roleWords,
  verificationWords,
  whoOf,
  wordsOf,
} from "./words.ts";

const id = (prefix: string, n: number) => `${prefix}_01jd${String(n).padStart(22, "0")}`;
const NADIA = ["nadia.brooks", "example.com"].join("@");

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: id("aud", 1),
    event: "staff.role_changed",
    category: "staff",
    at: "2026-11-17T15:02:44.000Z",
    actor: { kind: "staff", id: id("stf", 1), via: "admin", email: NADIA, name: null },
    target: { id: id("stf", 2), label: null },
    refs: [],
    organisationId: null,
    metadata: { fromRole: "viewer", toRole: "compliance", reason: "changed", lowered: false },
    verification: "passkey",
    address: "2001:db8::42",
    device: "Chrome on Mac",
    ...overrides,
  };
}

describe("the search in the URL", () => {
  it("keeps what is in its shape and drops what is not", () => {
    expect(
      readAuditSearch({
        show: "mine",
        actor: `${id("stf", 1)},bob,${id("stf", 1)}`,
        action: "staff.role_changed,DROP TABLE",
        org: "Acme",
        date: "30d",
        from: "2026-11-01",
        cursor: id("aud", 2),
        before: id("aud", 3),
        view: id("aud", 4),
        q: "nadia",
      }),
    ).toEqual({
      show: "mine",
      actor: id("stf", 1),
      action: "staff.role_changed",
      date: "30d",
      cursor: id("aud", 2),
      view: id("aud", 4),
    });
    expect(readAuditSearch({ show: "everything", view: "aud_x", date: "yesterday" })).toEqual({});
  });

  it("reads custom days in order, and drops a day that is not one", () => {
    expect(readAuditSearch({ from: "2026-11-21", to: "2026-11-01" })).toEqual({
      from: "2026-11-01",
      to: "2026-11-21",
    });
    expect(readAuditSearch({ from: "2026-02-30", to: "2026-11-01" })).toEqual({ to: "2026-11-01" });
  });

  it("asks the API for everything but the open entry, and the loader depends on the same", () => {
    const search: AuditSearch = {
      show: "rejections",
      action: "staff.customer_rejected",
      date: "week",
      cursor: id("aud", 2),
      view: id("aud", 4),
    };
    expect(apiQuery(search)).toEqual({
      limit: 50,
      show: "rejections",
      action: "staff.customer_rejected",
      date: "week",
      cursor: id("aud", 2),
    });
    expect(listDeps(search)).not.toHaveProperty("view");
  });

  it("starts a changed list at its newest row, with no entry open", () => {
    const search: AuditSearch = { show: "mine", cursor: id("aud", 2), view: id("aud", 3) };
    expect(withFilter(search, { date: "7d" })).toEqual({ show: "mine", date: "7d" });
    expect(toggled(search, "action", "switch.set")).toEqual({
      show: "mine",
      action: "switch.set",
    });
    expect(toggled({ action: "switch.set,staff.signed_in" }, "action", "switch.set")).toEqual({
      action: "staff.signed_in",
    });
    expect(toggled({ action: "switch.set" }, "action", "switch.set")).toEqual({});
  });

  it("clears the filters but keeps the view, and pages without an open entry", () => {
    expect(
      withoutFilters({ show: "mine", actor: id("stf", 1), date: "today", from: "2026-11-01" }),
    ).toEqual({ show: "mine" });
    expect(
      paged({ show: "mine", cursor: id("aud", 1), view: id("aud", 2) }, { before: id("aud", 3) }),
    ).toEqual({ show: "mine", before: id("aud", 3) });
  });

  it("draws the empty state the search calls for", () => {
    expect(emptyKind({})).toBe("firstUse");
    expect(emptyKind({ show: "rejections" })).toBe("viewEmpty");
    expect(emptyKind({ show: "mine", action: "switch.set" })).toBe("noResults");
    expect(emptyKind({ from: "2026-11-01" })).toBe("noResults");
  });

  it("links a row to its entry on this page, and Copy link to the list at its top", () => {
    expect(hrefOf({ action: "switch.set,staff.signed_in", view: id("aud", 1) })).toBe(
      `/audit?action=switch.set%2Cstaff.signed_in&view=${id("aud", 1)}`,
    );
    expect(hrefOf({})).toBe("/audit");
    expect(
      listLink("https://admin.example.com", {
        show: "mine",
        cursor: id("aud", 1),
        view: id("aud", 2),
      }),
    ).toBe("https://admin.example.com/audit?show=mine");
  });
});

describe("the chips", () => {
  const known = new Map([[id("stf", 2), "owen.price@example.com"]]);

  it("name each filter's values, Me for the viewer, and remove the whole filter", () => {
    const go = vi.fn();
    const chips = filterChips(
      {
        actor: `${id("stf", 1)},${id("stf", 2)},${id("stf", 3)}`,
        action: "staff.customer_rejected,staff.organization_paused",
        org: id("org", 1),
        date: "30d",
        cursor: id("aud", 9),
      },
      id("stf", 1),
      known,
      go,
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      "Staff member: Me, owen.price@example.com, A member of staff",
      "Action: Rejected a customer, Paused Production access",
      `Organisation: ${id("org", 1)}`,
      "Date: Last 30 days",
    ]);
    chips[1]?.onRemove();
    expect(go).toHaveBeenCalledWith({
      actor: `${id("stf", 1)},${id("stf", 2)},${id("stf", 3)}`,
      org: id("org", 1),
      date: "30d",
    });
  });

  it("say custom days as days", () => {
    expect(dateLabel({ from: "2026-11-01", to: "2026-11-03" })).toBe("1 Nov 2026 – 3 Nov 2026");
    expect(dateLabel({ from: "2026-11-01", to: "2026-11-01" })).toBe("1 Nov 2026");
    expect(dateLabel({ from: "2026-11-01" })).toBe("from 1 Nov 2026");
    expect(dateLabel({ to: "2026-11-03" })).toBe("until 3 Nov 2026");
    expect(dateLabel({})).toBeNull();
    expect(personLabel(id("stf", 9), null, known)).toBe("A member of staff");
  });
});

describe("the words", () => {
  // Spec 08 §3.4's staff-scope events (staff.ts, platform.ts, staff-kyc.ts, staff-settings.ts and
  // money.ts's staff rows), less the three that are log lines, not rows.
  const STAFF_SCOPE = [
    "staff.signed_in",
    "staff.second_factor_required",
    "staff.signed_out",
    "staff.session_revoked",
    "staff.signed_out_everywhere",
    "staff.sign_in_failed",
    "staff.step_up_passed",
    "staff.step_up_failed",
    "staff.step_up_locked",
    "staff.factor_setup_started",
    "staff.factor_added",
    "staff.factor_removed",
    "staff.factor_enrolled",
    "staff.enrolment_code_issued",
    "staff.enrolment_code_redeemed",
    "staff.member_added",
    "staff.role_changed",
    "staff.member_removed",
    "staff.factors_reset",
    "staff.role_created",
    "staff.role_updated",
    "staff.role_deleted",
    "staff.bootstrapped",
    "switch.set",
    "switch.cleared",
    "switch.tripped",
    "audit.epoch_started",
    "audit.restore_replayed",
    "audit.failover_recorded",
    "operator.task_completed",
    "operator.credential_rotated",
    "operator.escrow_opened",
    "system.sweep_completed",
    "staff.customer_approved",
    "staff.customer_unapproved",
    "staff.customer_rejected",
    "staff.customer_restart_allowed",
    "staff.customer_details_shown",
    "staff.document_viewed",
    "staff.rfi_created",
    "staff.rfi_accepted",
    "staff.rfi_more_needed",
    "staff.rfi_withdrawn",
    "staff.rfi_changed",
    "staff.form_created",
    "staff.form_updated",
    "staff.form_published",
    "staff.form_archived",
    "staff.fin_approval_enabled",
    "staff.fin_approval_disabled",
    "staff.go_live_first_approval",
    "staff.go_live_approved",
    "staff.go_live_changes_requested",
    "staff.go_live_declined",
    "staff.organization_paused",
    "staff.organization_restore_requested",
    "staff.organization_restored",
    "staff.approval_cancelled",
    "staff.approval_expired",
    "staff.flag_resolved",
    "staff.reveal_budget_reached",
    "system.kyc_write_refused",
    "system.kyc_unknown_applicant",
    "staff.reason_preset_added",
    "staff.reason_preset_renamed",
    "staff.reason_preset_moved",
    "staff.reason_preset_retired",
    "staff.reason_preset_restored",
    "staff.message_template_added",
    "staff.message_template_changed",
    "staff.message_template_retired",
    "staff.message_template_restored",
    "staff.saved_view_created",
    "staff.saved_view_deleted",
    "money.holder.retry_requested",
    "money.routing_decided",
    "beneficiary.sealed_opened",
    "beneficiary.registered",
    "treasury.funding_created",
    "money.reconciliation_break",
    "money.reconciliation_break_resolved",
  ];

  it("say every staff-scope event, each once in the Action filter, and an unknown one by name", () => {
    const listed = ACTION_GROUPS.flatMap((group) => Object.keys(group.events));
    expect([...listed].sort()).toEqual([...STAFF_SCOPE].sort());
    for (const event of STAFF_SCOPE) expect(wordsOf(event), event).not.toBe(event);
    expect(wordsOf("staff.something_new")).toBe("staff.something_new");
  });

  it("name who acted", () => {
    expect(whoOf(entry())).toBe(NADIA);
    expect(
      whoOf(
        entry({
          actor: { kind: "operator", id: "run_1", via: "operator", email: null, name: null },
        }),
      ),
    ).toBe("Operator");
    expect(
      whoOf(entry({ actor: { kind: "system", id: null, via: "job", email: null, name: null } })),
    ).toBe("Fin");
    expect(
      whoOf(
        entry({
          actor: { kind: "provider", id: "sumsub", via: "webhook", email: null, name: null },
        }),
      ),
    ).toBe("Sumsub");
    expect(
      whoOf(
        entry({
          actor: { kind: "staff", id: id("stf", 9), via: "admin", email: null, name: null },
        }),
      ),
    ).toBe("A member of staff");
  });

  it("give a reason's words and code, or none for a change made by hand", () => {
    expect(reasonOf(entry({ metadata: { reasonCode: "risk_review" } }))).toEqual({
      words: "Risk review",
      code: "risk_review",
    });
    expect(reasonOf(entry({ metadata: { reason: "role_deleted" } }))).toEqual({
      words: "Their role was deleted",
      code: "role_deleted",
    });
    expect(reasonOf(entry())).toBeNull();
    expect(reasonOf(entry({ metadata: {} }))).toBeNull();
    expect(humanise("source_of_funds")).toBe("Source of funds");
  });

  it("say what changed, from the pairs and from each event's own fields", () => {
    expect(changesOf(entry())).toEqual([{ field: "Role", before: "Viewer", after: "Compliance" }]);
    expect(
      changesOf(entry({ metadata: { fromStatus: "live", toStatus: "paused" }, event: "x.y" })),
    ).toEqual([{ field: "Status", before: "Live", after: "Paused" }]);
    expect(
      changesOf(entry({ event: "staff.member_added", metadata: { roleKey: id("srl", 1) } })),
    ).toEqual([{ field: "Role", before: "None", after: "A custom role" }]);
    expect(
      changesOf(entry({ event: "switch.cleared", metadata: { reasonCode: "drill" } })),
    ).toEqual([{ field: "Kill switch", before: "On", after: "Off" }]);
    expect(
      changesOf(entry({ event: "staff.factors_reset", metadata: { factorsRemoved: 2 } })),
    ).toEqual([{ field: "Second factors", before: "2", after: "None" }]);
    expect(changesOf(entry({ event: "staff.document_viewed", metadata: {} }))).toEqual([]);
    expect(roleWords("admin")).toBe("Admin");
  });

  it("say how the actor was verified", () => {
    expect(verificationWords("passkey")).toBe("Passkey");
    expect(verificationWords("totp")).toBe("Authenticator app");
    expect(verificationWords("session")).toBe("Signed-in session");
    expect(verificationWords(null)).toBeNull();
  });
});

describe("the times (UTC)", () => {
  it("are the column's, the drawer's and a day's", () => {
    expect(formatWhen("2026-11-17T15:02:44.000Z")).toBe("17 Nov 2026, 15:02:44");
    expect(formatWhenLong("2026-11-17T15:02:44.000Z")).toBe("17 November 2026, 15:02:44 UTC");
    expect(formatDay("2026-11-01")).toBe("1 Nov 2026");
    expect(formatWhen("not a time")).toBe("not a time");
    expect(rowLabel(entry({ target: { id: id("stf", 2), label: "owen.price@example.com" } }))).toBe(
      `Changed a member of staff’s role, owen.price@example.com, ${NADIA}, 17 Nov 2026, 15:02:44 UTC`,
    );
    expect(shortId(id("org", 7))).toBe("org_01jd0000…000007");
    expect(totalLine(1, false)).toBe("1 staff action");
    expect(totalLine(10_000, true)).toBe("10,000 or more staff actions");
  });
});

describe("loadAudit", () => {
  const ok: StaffViewer = {
    state: "ok",
    staff: { id: id("stf", 1), email: NADIA, roleKey: "viewer", roleLabel: "Viewer" },
    permissions: ["audit.read"],
    environment: "staging",
  };
  const viewer = (v: StaffViewer | null) => ({ get: () => v }) as never;

  it("reads nothing without audit.read", async () => {
    const api = vi.fn();
    expect(
      await loadAudit({ api, viewer: viewer({ ...ok, permissions: ["staff.read"] }) } as never, {}),
    ).toEqual({ kind: "notAllowed" });
    expect(await loadAudit({ api, viewer: viewer(null) } as never, {})).toEqual({
      kind: "notAllowed",
    });
    expect(api).not.toHaveBeenCalled();
  });

  it("reads the page the search names", async () => {
    const page = auditPageAnswer.parse({
      items: [entry()],
      total: 1,
      totalCapped: false,
      nextCursor: null,
      previousCursor: null,
      people: [],
    });
    const api = vi.fn().mockResolvedValue(page);
    expect(await loadAudit({ api, viewer: viewer(ok) } as never, { show: "mine" })).toEqual({
      kind: "ready",
      page,
    });
    expect(api).toHaveBeenCalledWith(listAudit, { limit: 50, show: "mine" });
  });

  it("fails to the page's own state, with the request ID, or offline", async () => {
    const problem = new ApiError({
      kind: "problem",
      contract: "audit.list",
      status: 500,
      requestId: "req_1",
    });
    expect(
      await loadAudit({ api: vi.fn().mockRejectedValue(problem), viewer: viewer(ok) } as never, {}),
    ).toEqual({ kind: "failed", requestId: "req_1", offline: false });
    const network = new ApiError({ kind: "network", contract: "audit.list" });
    expect(
      await loadAudit({ api: vi.fn().mockRejectedValue(network), viewer: viewer(ok) } as never, {}),
    ).toEqual({ kind: "failed", requestId: null, offline: true });
  });
});

describe("the contract", () => {
  it("names the two reads under /api, as GETs", () => {
    expect(listAudit).toMatchObject({ method: "GET", path: "/audit" });
    expect(getAuditEntry).toMatchObject({ method: "GET", path: "/audit/:eventId" });
  });

  it("refuses an answer without the cursors or with a row that is not an audit entry", () => {
    const base = { items: [entry()], total: 1, totalCapped: false, people: [] };
    expect(auditPageAnswer.safeParse(base).success).toBe(false);
    expect(
      auditPageAnswer.safeParse({
        ...base,
        nextCursor: null,
        previousCursor: null,
        items: [{ ...entry(), id: "evt_1" }],
      }).success,
    ).toBe(false);
  });
});

describe("static parts", () => {
  it("draws the skeleton with the header and loading rows, never a spinner (loading)", () => {
    const html = renderToStaticMarkup(<AuditSkeleton />);
    expect(html).toContain(">Audit log</h1>");
    expect(html).toContain("data-skeleton-row");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("fin-ico-spin");
  });

  it("draws an entry's details and what changed (drawer)", () => {
    const html = renderToStaticMarkup(
      <EntryDetails
        entry={entry({
          organisationId: id("org", 7),
          metadata: { ...entry().metadata, reasonCode: "risk_review" },
        })}
      />,
    );
    expect(html).toContain("Changed a member of staff’s role");
    expect(html).toContain("staff.role_changed");
    expect(html).toContain("17 November 2026, 15:02:44 UTC");
    expect(html).toContain("Risk review");
    expect(html).toContain("Passkey");
    expect(html).toContain("2001:db8::42 · Chrome on Mac");
    expect(html).toContain("Viewer → ");
    expect(html).not.toContain("Nothing changed");
  });

  it("says when nothing changed (drawerNoChange)", () => {
    const html = renderToStaticMarkup(
      <EntryDetails entry={entry({ event: "staff.document_viewed", metadata: {} })} />,
    );
    expect(html).toContain("Nothing changed, or this action is from before Fin kept what changed.");
    expect(html).toContain("No reason asked");
    expect(html).toContain("None");
  });
});
