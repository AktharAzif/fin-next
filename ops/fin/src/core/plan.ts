// Plans and dry-run diffs. Every apply command first reads the provider's current state, builds the
// list of changes it would make, prints it, and only then (without --dry-run) applies it. A plan
// that deletes anything needs `--confirm-delete <n>` with exactly the number of deletions, so a
// mistaken desired state cannot remove objects silently.

import { RefusedError } from "./errors.ts";

export type ChangeAction = "create" | "update" | "delete" | "keep";

export interface Change {
  /** What kind of object: `dns`, `route`, `rule`, `setting`, `access-app`, `variable`, ... */
  kind: string;
  /** Its display name (masked when printed). */
  name: string;
  action: ChangeAction;
  /** For an update, the fields that differ. */
  fields?: readonly string[];
  /** A short description of the desired state. */
  detail?: string;
  /** When set, the change is reported but not applied, and this says why. */
  held?: string;
}

const MARK: Record<ChangeAction, string> = { create: "+", update: "~", delete: "-", keep: "=" };

export interface PlanSummary {
  create: number;
  update: number;
  delete: number;
  keep: number;
  held: number;
}

export function summarize(changes: readonly Change[]): PlanSummary {
  const summary: PlanSummary = { create: 0, update: 0, delete: 0, keep: 0, held: 0 };
  for (const change of changes) {
    if (change.held !== undefined && change.action !== "keep") summary.held++;
    else summary[change.action]++;
  }
  return summary;
}

/** The plan as lines, one per change, then a summary line. */
export function formatPlan(title: string, changes: readonly Change[]): string[] {
  const lines = [`${title}:`];
  for (const change of changes) {
    const mark = change.held !== undefined && change.action !== "keep" ? "!" : MARK[change.action];
    const fields =
      change.fields !== undefined && change.fields.length > 0
        ? ` [${change.fields.join(", ")}]`
        : "";
    const detail = change.detail !== undefined ? ` ${change.detail}` : "";
    const held =
      change.held !== undefined && change.action !== "keep" ? ` (held: ${change.held})` : "";
    lines.push(`  ${mark} ${change.action} ${change.kind} ${change.name}${fields}${detail}${held}`);
  }
  const s = summarize(changes);
  lines.push(
    `  ${s.create} to create, ${s.update} to update, ${s.delete} to delete, ${s.keep} unchanged` +
      (s.held > 0 ? `, ${s.held} held` : ""),
  );
  return lines;
}

/** The changes that would be sent: everything but `keep` and held changes. */
export function pending(changes: readonly Change[]): Change[] {
  return changes.filter((c) => c.action !== "keep" && c.held === undefined);
}

/** Refuses a plan with deletions unless --confirm-delete names exactly their number. */
export function checkDeletes(changes: readonly Change[], confirmDelete: number | undefined): void {
  const deletions = pending(changes).filter((c) => c.action === "delete").length;
  if (deletions === 0) return;
  if (confirmDelete !== deletions) {
    throw new RefusedError(
      `the plan deletes ${deletions} object(s); re-run with --confirm-delete ${deletions} to allow it`,
    );
  }
}

/** Canonical JSON (sorted keys), so equal objects compare and hash equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The names of the fields whose canonical values differ between two objects. */
export function differingFields(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
): string[] {
  return Object.keys(desired)
    .filter((key) => canonical(current[key]) !== canonical(desired[key]))
    .sort();
}
