// The alerts that are owed: named by code (a package's line list, such as
// packages/identity/src/monitoring.ts, or a comment that names an alert) or by a catalogue entry's
// `owed`, before the alert fragment that defines them has landed. Each is listed with the lane that
// owes it and the date it is due (the steward's ruling of 22 Nov, option (b)). monitoring:check
// (MC-15) fails for an alert name that code or the catalogue gives which is neither a rule in
// ops/monitoring/<env>/alerts/*.json nor listed here, for an entry here without a lane or a date,
// and for an entry here that a fragment already defines: the lane that lands the alert moves it to
// the catalogue entry's `alerts` and removes it from this list in the same pull request.
//
// The lane is the one whose row in EXECUTION's lane tables carries the fragment's work: L-SAT-09
// ("Auth alerts and catalogue fragments", ops/monitoring/**) for spec 02 §18.2's identity and
// staff alerts, P0-F (ops/monitoring/** in Phase 0) for the audit fragment, the email lane for its
// own alerts, fin-review's lane for its alerts and the Monday ops lane for the money alerts. A
// Saturday lane's unfinished work is finished in Sunday's spill block (L-SUN-00).

export interface OwedAlert {
  /** The alert's name, as its fragment will define it. */
  readonly name: string;
  /** P pages in production, N notifies; staging emails the quiet policy either way. */
  readonly severity: "P" | "N";
  /** The fragment that will define it: ops/monitoring/<env>/alerts/<fragment>.json. */
  readonly fragment: string;
  /** The lane that owes it (EXECUTION's lane tables). */
  readonly lane: string;
  /** The date it is due, YYYY-MM-DD. */
  readonly due: string;
  /** Where the plan defines it. */
  readonly spec: string;
  /** A heartbeat it needs too, owed with it (ops/monitoring/<env>/heartbeats.json). */
  readonly heartbeat?: string;
}

/** Spec 02 §18.2's alerts and the audit guard, due by the steward's ruling of 22 Nov. */
const SUNDAY = "2026-11-22";

export const OWED_ALERTS: readonly OwedAlert[] = [
  // The steward's ruling of 22 Nov, option (b): the alerts the code names.
  {
    name: "sign-in-failing",
    severity: "P",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "second-factor-step-failing",
    severity: "P",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "step-up-failing",
    severity: "N",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "sign-in-code-contested",
    severity: "N",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "step-up-locked",
    severity: "N",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "secret-unreadable",
    severity: "P",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "rate-limiter-failing",
    severity: "P",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "csrf-refused-jump",
    severity: "N",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "admin-staff-refused",
    severity: "P",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "admin-without-second-factor",
    severity: "P",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "admin-access-mismatch",
    severity: "P",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "staff-enrolled",
    severity: "N",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "staff-enrolment-refused",
    severity: "N",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    // Named by the Access drift duty (packages/staff/src/access-drift.ts): no successful run in
    // two hours. It needs the duty's heartbeat, which the duty pings after each successful run.
    name: "duty-stalled-access-drift",
    severity: "N",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §10.9, §18.2",
    heartbeat: "access-drift",
  },
  {
    name: "audit-guard",
    severity: "P",
    fragment: "audit",
    lane: "P0-F",
    due: SUNDAY,
    spec: "spec 08 §3.14",
  },
  // Named as owed by the catalogue (and the first two by identity's line list as well), in the
  // same fragments or their areas' own; the steward confirms each lane and date.
  {
    name: "auth-endpoint-unlisted",
    severity: "N",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "security-email-unsent",
    severity: "P",
    fragment: "email",
    lane: "L-SAT-05",
    due: SUNDAY,
    spec: "spec 08 §7.8 group G",
  },
  {
    name: "email-budget-reached",
    severity: "N",
    fragment: "email",
    lane: "L-SAT-05",
    due: SUNDAY,
    spec: "spec 08 §7.8 group G",
  },
  {
    name: "admin-access-drift",
    severity: "P",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "access-keys-unavailable",
    severity: "P",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    name: "staff-changed",
    severity: "N",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  {
    // Its lines are local until fin-review ships them to Better Stack.
    name: "review-refusals",
    severity: "N",
    fragment: "review",
    lane: "P0-C",
    due: SUNDAY,
    spec: "spec 07 §12.3",
  },
  {
    name: "review-model-mismatch",
    severity: "P",
    fragment: "review",
    lane: "P0-C",
    due: SUNDAY,
    spec: "spec 07 §12.3",
  },
  {
    // No Phase 0 code calls tripSwitch; the money switches come with Monday's money lanes.
    name: "money-switch-tripped",
    severity: "P",
    fragment: "money",
    lane: "L-MON-09",
    due: "2026-11-23",
    spec: "spec 04 §30.3",
  },
];
