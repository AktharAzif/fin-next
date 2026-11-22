// An audit row as the boards draw it: the sentence with the actor and object in the text colour,
// the address and device under it, and the "Verified by" chip.
import { Badge } from "@fin/ui";
import type { AuditRow } from "../api/contracts/audit.ts";
import { describe, verifiedLabel } from "../audit/sentences.ts";

export function AuditSentence({ row, you }: { row: AuditRow; you?: string | null }) {
  const sentence = describe(row, you ?? null);
  return (
    <p className="m-0 text-body text-text-secondary">
      <span className="font-medium text-text-primary">{sentence.actor}</span> {sentence.verb}
      {sentence.object === null ? null : (
        <>
          {" "}
          <span
            className={
              sentence.mono
                ? "font-mono text-mono text-text-primary"
                : "font-medium text-text-primary"
            }
          >
            {sentence.object}
          </span>
        </>
      )}
      {sentence.tail}
    </p>
  );
}

/** "198.51.100.24 · Chrome on Mac", or nothing when the row has neither. */
export function whereLine(row: AuditRow): string | null {
  const parts = [row.ipAddress, row.device].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

export function AuditWhere({ row }: { row: AuditRow }) {
  const line = whereLine(row);
  return line === null ? null : (
    <p className="m-0 text-caption text-text-tertiary tabular-nums">{line}</p>
  );
}

export function VerifiedChip({ verification }: { verification: string | null | undefined }) {
  const label = verifiedLabel(verification);
  return label === null ? (
    <span className="text-text-tertiary">—</span>
  ) : (
    <Badge variant="secondary" size="sm">
      {label}
    </Badge>
  );
}
