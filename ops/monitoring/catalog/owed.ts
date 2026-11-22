// The alerts that are owed: named by code (a package's line list, such as
// packages/identity/src/monitoring.ts, or a comment that names an alert) or by a catalogue entry's
// `owed`, before the alert fragment that defines them has landed. Each is listed with the lane that
// owes it and the date it is due (the steward's ruling of 22 Nov, option (b)). monitoring:check
// (MC-15) fails for an alert name that code or the catalogue gives which is neither a rule in
// ops/monitoring/<env>/alerts/*.json nor listed here, for an entry here without a lane or a date,
// and for an entry here that a fragment already defines: the lane that lands the alert moves it to
// the catalogue entry's `alerts` and removes it from this list in the same pull request.
//
// A defined alert can owe a part as well: a trigger the plan gives it that reads a line nothing in
// the tree writes. The rule fires on the rest, and OWED_PARTS below lists the part with its lane,
// its date and why (held by test/sat09-alerts.test.ts); the lane that builds the part adds it to
// the rule and removes it there in the same pull request.
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
// refuses the deploy while any entry here exists, an owed part included. It is not built yet
// because production has no deploy path yet (ops/fin and tools/static-deploy know only staging); a
// production gate in ops/fin now would guard a path that does not exist. Until it is built, this
// paragraph and the plan's entry are the record that it is owed.

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
  // The steward's ruling of 22 Nov, option (b): the alerts the code names. The later ruling of
  // 22 Nov (L-SAT-09 carries every owed alert due today, in its build order) made rules of
  // secret-unreadable, rate-limiter-failing, csrf-refused-jump, audit-guard and the sign-in and
  // step-up rates; what is left here is owed for the reason in its note.
  {
    name: "sign-in-code-contested",
    severity: "N",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
    note:
      "Owed, not defined: spec 02 §18.2 fires it for one userId above its threshold, so its series " +
      "is the userId, a label every line chooses (an ID, unbounded), which this repository's rules " +
      "refuse (each series label is held to a closed set); a count over every account would be " +
      "sign-in-failures-spike's job, not this one. It needs a per-account count the alert can read " +
      "without an ID label (a metric of counts by account, or a writer that marks the account's " +
      "own threshold crossed), which the identity lane decides; spec 02 §18.3's panel shows the " +
      "lines meanwhile.",
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
    note:
      "Not built on 22 Nov: it comes after the ruling's build order (the Fin Admin access alerts, " +
      "then audit-guard, secret-unreadable, rate-limiter-failing, csrf-refused-jump and the email " +
      "delivery stall, then the sign-in and step-up rates). Its rule needs the exact route " +
      "templates of the team and role routes as console's request line names them (the query " +
      "language matches values, not prefixes), held by a test against console's route policy " +
      "(apps/console/src/server/policy/orgs.ts). Meanwhile a 5xx on those routes is " +
      "5xx-rate-console and 5xx-count-console.",
  },
  // Defined in alerts/platform.json until its read event was found to have no writer: an alert
  // that reads a field or event nobody writes can never fire, so it is owed, not defined. Its lane
  // (the platform fragment's) follows the lane rule above; the steward confirms or changes it.
  {
    name: "github-settings-changed",
    severity: "P",
    fragment: "platform",
    lane: "P0-F",
    due: SUNDAY,
    spec: "spec 08 §7.8 group J",
    note:
      "Owed, not defined, because nothing writes what it read: a run.done of the command " +
      "`github verify` with result drift, and pnpm fin has no such command (none of the command " +
      "lists ops/fin/src/cli.ts joins names one) while a run's result is ok, failed or refused " +
      "only (RunResult in " +
      "ops/fin/src/core/run.ts). The pull request that adds pnpm fin github verify puts the rule " +
      "back in alerts/platform.json over the line it writes (runbook " +
      "docs/runbooks/github-settings-changed.md) and removes it here.",
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

/** A trigger the plan gives a defined alert that its rule cannot read yet (the header above). */
export interface OwedPart {
  /** The alert, a rule of its fragment that fires on its other triggers. */
  readonly alert: string;
  /** The trigger that is owed, in the plan's words. */
  readonly part: string;
  /** The fragment that defines the alert: ops/monitoring/<env>/alerts/<fragment>.json. */
  readonly fragment: string;
  /** The lane that owes it (EXECUTION's lane tables). */
  readonly lane: string;
  /** The date it is due, YYYY-MM-DD. */
  readonly due: string;
  /** Where the plan defines it. */
  readonly spec: string;
  /** Why the rule cannot read it yet, and what it needs. */
  readonly note: string;
}

export const OWED_PARTS: readonly OwedPart[] = [
  {
    alert: "sign-in-failing",
    part: "successful sign-ins at zero while attempts continue",
    fragment: "identity",
    lane: "L-SAT-09",
    due: SUNDAY,
    spec: "spec 02 §18.2",
    note:
      "Owed, not built: the rule fires on spec 02 §18.2's 5xx half only (auth.unhandled_error " +
      "off the factor-step paths), because no line names a sign-in attempt or its outcome by " +
      "path where the realms run. The realm keeps authPath on its request state, but console's and " +
      "admin's annotate hooks (apps/console/src/server/routes.ts, " +
      "apps/admin/src/server/auth-hook.ts) copy only the outcome, the reason and the actor onto " +
      "the host's one request line, whose route is the pattern /api/auth/*; packages/server's " +
      "RequestFields has no authPath and the request catalogue entry declares none. " +
      "session.created is an audit event, not a line, and auth.unhandled_error names the path " +
      "for a 500 only. Once the host's request line for /api/auth/* carries the realm's " +
      "authPath (or the realm writes a bounded sign-in outcome line), the part is a rule over " +
      "the sign-in paths' lines that fires while attempts continue and none ends ok, in " +
      "alerts/identity.json beside the 5xx half, runbook docs/runbooks/sign-in-failing.md.",
  },
];
