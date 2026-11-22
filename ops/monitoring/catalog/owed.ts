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
// ("Auth alerts and catalogue fragments", ops/monitoring/**) for spec 02 §18.2's identity, staff
// and organisation alerts, P0-F (ops/monitoring/** in Phase 0) for the audit fragment,
// fin-review's lane for its alerts and the Monday ops lane for the money alerts. A Saturday lane's
// unfinished work is finished in Sunday's spill block (L-SUN-00).
//
// A HARD PRODUCTION PRECONDITION (the steward's ruling of 22 Nov; the plan records it): no owed
// alert reaches production. Before production's first deploy, a gate is built on whatever path
// production really takes: the operator's launcher outside this repository (CI-04, FD-19), static
// uploads included. The gate reads this list as data, fails closed when it cannot read it, and
// refuses the deploy while any entry here exists. It is not built yet because production has no
// deploy path yet (ops/fin and tools/static-deploy know only staging); a production gate in
// ops/fin now would guard a path that does not exist. Until it is built, this paragraph and the
// plan's entry are the record that it is owed.

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
  /**
   * A heartbeat a ruling gives it, owed with it (ops/monitoring/<env>/heartbeats.json); the note
   * says when the plan and the ruling differ on it.
   */
  readonly heartbeat?: string;
  /** A fact the lane needs, or a question the lane settles when it builds the alert. */
  readonly note?: string;
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
    name: "admin-without-second-factor",
    severity: "P",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
    note:
      "Owed, not defined, because no admin request line carries assurance (spec 02 §18.1's field): " +
      "the staff realm keeps it on its own request state, but admin's auth hook copies only the " +
      "outcome, the reason and the actor onto the host's one request line " +
      "(apps/admin/src/server/auth-hook.ts), the guarded routes set the route, the actor and the " +
      "outcome only (apps/admin/src/server/routes/register.ts), packages/server's RequestFields has " +
      "no such field, and the request catalogue entry declares none. A rule over the missing field " +
      "would never fire (eq) or fire on every staff request (notEq matches a line without it). " +
      "Once admin's request line carries assurance, the rule is any request on admin with actor " +
      "staff, assurance notEq aal2 (failing closed), statusClass 1xx, 2xx or 3xx, and a route " +
      "outside spec 02 §6.4's aal1-allowed list, P, runbook " +
      "docs/runbooks/admin-without-second-factor.md.",
  },
  {
    // Named by the Access drift duty (packages/staff/src/access-drift.ts) as its success alert.
    name: "duty-stalled-access-drift",
    severity: "N",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §10.9, §18.2",
    note:
      "The heartbeat question is decided (22 Nov, L-SAT-09) by the plan's order of precedence: " +
      "no heartbeat. The area's own spec, spec 02 §10.9, says the duty pings no heartbeat but has " +
      "a success alert; ARCHITECTURE §4.6, higher, lets a duty name a heartbeat or a success alert, " +
      "and neither its §10.7 heartbeat table nor spec 01 §8.5 names one for this duty. The " +
      "steward's earlier ruling, which gave it a heartbeat access-drift pinged after each " +
      "successful run, is no text of the plan's order, so the plan's text binds and " +
      "heartbeats.json gains nothing. Still owed: no process runs the duty yet (see " +
      "admin-access-drift), so nothing writes its job.run line and its job name is not fixed " +
      "(spec 02 §18.1 names it staff.access_drift). Once the worker runs it, the rule is no " +
      "job.run with that job and result ok in its window (lower_than @none, on_missing_data " +
      "start_incident, window @thresholds.duty-stalled-access-drift: spec 02 §18.2 says 2 hours, " +
      "ARCHITECTURE §4.6 and spec 08 §7.8 three cadences, 3 hours, and the higher text binds), " +
      "runbook docs/runbooks/duty-stalled.md.",
  },
  // Named as owed by the catalogue, in the same fragments or their areas' own: owed, with these
  // lanes and dates, by the steward's later ruling of 22 Nov, and not built now.
  {
    name: "admin-access-drift",
    severity: "P",
    fragment: "staff",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
    note:
      "packages/staff's runAccessDriftCheck writes access.drift with its counts " +
      "(access-drift.db.test.ts), but no process runs the duty yet: the worker " +
      "(apps/api/src/worker/main.ts) runs the email loop, the delivery check and the database " +
      "probe only, and apps/api does not depend on @fin/staff. An alert over a line no process " +
      "writes can never fire, so it stays owed, as clock-skew does, until the worker schedules " +
      "the duty with FIN_ACCESS_READ_TOKEN; the rule is then any access.drift on worker, P, " +
      "runbook docs/runbooks/admin-access-drift.md.",
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
  // Named by orgs.ts and owed by the request entry: 5xx on the team and role routes. Its lane and
  // date follow the lane rule above, as the ruled identity and staff alerts' do; no ruling names
  // it yet, and the steward confirms or changes them.
  {
    name: "team-change-failing",
    severity: "N",
    fragment: "orgs",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
  },
  // Defined in alerts/platform.json until its field was found to have no writer: an alert that
  // reads a field nobody writes can never fire, so it is owed, not defined. Its lane (the
  // platform fragment's) and date follow the lane rule above; the steward confirms or changes them.
  {
    name: "clock-skew",
    severity: "N",
    fragment: "platform",
    lane: "P0-F",
    due: SUNDAY,
    spec: "spec 01 §8.7, DECISIONS CF-72",
    note: "No process writes clockSkewMs: process.health carries what a service's health hook gives (packages/server's BuiltService.health), and none gives the offset from the database's now() yet (P0-D's health line, with P0-E's pool and probe). The pull request that makes a process write it puts the rule back in alerts/platform.json (threshold @thresholds.clock-skew, runbook docs/runbooks/clock-skew.md) and removes it here.",
  },
];
