// An entry of the audit log (the board's drawer; INV §4.14's panel): the whole record, with no
// full page behind it. Details (who, the action and its key, the target, the organisation, when,
// the reason), how the actor was verified and the address and device of the request ([BC-03]),
// then "What changed". Opened from a row (`view=<aud_…>`), it steps through the page's rows
// ("‹ 4 of 50 ›"); opened from a link to a row not on the page, it reads that one entry and shows
// its loading, failed and not-found states.
//
// @pendingDesign UR-24: the Drawer (S) and DetailList of @fin/ui; until the kit has them, the
// board's side sheet is @fin/ui's Modal drawn at the drawer's width on the right, and the details
// a definition list composed from tokens.
import type { StaffViewer } from "@fin/app-contracts";
import { isApiError, useFin } from "@fin/frame";
import { CaretLeftIcon, CaretRightIcon } from "@fin/icons";
import { Badge, CopyField, ErrorState, IconButton, Modal, SkeletonSection } from "@fin/ui";
import { type ReactNode, useEffect, useState } from "react";
import { type AuditEntry, getAuditEntry } from "./contract.ts";
import { formatWhenLong } from "./format.ts";
import { changesOf, reasonOf, verificationWords, whoOf, wordsOf } from "./words.ts";

/** The side sheet: the drawer's S width, full height, on the right; full width on phones. */
const SHEET = "inset-x-auto right-0 m-0 h-full max-h-full w-full max-w-drawer-s rounded-none gap-6";

const NOTHING_CHANGED = "Nothing changed, or this action is from before Fin kept what changed.";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-body text-text-secondary">{label}</dt>
      <dd className="m-0 min-w-0 text-body text-text-primary">{children}</dd>
    </div>
  );
}

/** The ready drawer's body: the details, then what changed. */
export function EntryDetails({ entry }: { entry: AuditEntry }) {
  const reason = reasonOf(entry);
  const changes = changesOf(entry);
  const verified = verificationWords(entry.verification);
  const where = [entry.address, entry.device].filter((part) => part !== null).join(" · ");
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="audit-details" className="flex flex-col gap-2">
        <h3 id="audit-details" className="m-0 text-label text-text-primary">
          Details
        </h3>
        <dl className="m-0 flex flex-col divide-y divide-border">
          <Row label="Who">
            <span className="flex flex-col">
              <span>{whoOf(entry)}</span>
              {entry.actor.name === null ? null : (
                <span className="text-caption text-text-tertiary">{entry.actor.name}</span>
              )}
            </span>
          </Row>
          <Row label="Action">
            <span className="inline-flex flex-wrap items-baseline gap-2">
              <span>{wordsOf(entry.event)}</span>
              <span className="font-mono text-mono text-text-tertiary">{entry.event}</span>
            </span>
          </Row>
          <Row label="Target">
            <span className="flex min-w-0 flex-col gap-1">
              {entry.target.label === null ? null : <span>{entry.target.label}</span>}
              <CopyField value={entry.target.id} label="Target" head={12} tail={6} />
            </span>
          </Row>
          <Row label="Organisation">
            {entry.organisationId === null ? (
              <span className="text-text-tertiary">None</span>
            ) : (
              <CopyField value={entry.organisationId} label="Organisation ID" head={12} tail={6} />
            )}
          </Row>
          <Row label="When">{formatWhenLong(entry.at)}</Row>
          <Row label="Reason">
            {reason === null ? (
              <span className="text-text-tertiary">No reason asked</span>
            ) : (
              <span className="inline-flex flex-wrap items-baseline gap-2">
                <span>{reason.words}</span>
                <span className="font-mono text-mono text-text-tertiary">{reason.code}</span>
              </span>
            )}
          </Row>
          {verified === null ? null : (
            <Row label="Verified with">
              <Badge variant="secondary">{verified}</Badge>
            </Row>
          )}
          {where === "" ? null : (
            <Row label="From">
              <span className="tabular-nums">{where}</span>
            </Row>
          )}
          <Row label="Entry ID">
            <CopyField value={entry.id} label="Entry ID" head={12} tail={6} />
          </Row>
        </dl>
      </section>
      <section
        aria-labelledby="audit-changes"
        className="flex flex-col gap-2 border-t border-border pt-6"
      >
        <h3 id="audit-changes" className="m-0 text-label text-text-primary">
          What changed
        </h3>
        {changes.length === 0 ? (
          <p className="m-0 text-body text-text-secondary">{NOTHING_CHANGED}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {changes.map((change) => (
              <li key={change.field} className="text-body text-text-primary">
                <span className="text-text-secondary">{change.field}:</span> {change.before} →{" "}
                {change.after}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Loaded =
  | { readonly id: string; readonly kind: "loading" }
  | { readonly id: string; readonly kind: "ready"; readonly entry: AuditEntry }
  | { readonly id: string; readonly kind: "failed"; readonly requestId: string | null }
  | { readonly id: string; readonly kind: "notFound" };

/** Reads one entry that is not on the page (a deep link), with a retry. */
function useEntry(id: string, onPage: AuditEntry | undefined): [Loaded, () => void] {
  const fin = useFin<StaffViewer>();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ id, kind: "loading" });
  useEffect(() => {
    if (onPage !== undefined) return;
    const controller = new AbortController();
    setLoaded({ id, kind: "loading" });
    fin.api(getAuditEntry, { eventId: id }, { signal: controller.signal }).then(
      (answer) => setLoaded({ id, kind: "ready", entry: answer.entry }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isApiError(error) && error.status === 404) setLoaded({ id, kind: "notFound" });
        else
          setLoaded({ id, kind: "failed", requestId: isApiError(error) ? error.requestId : null });
      },
    );
    return () => controller.abort();
  }, [fin, id, onPage, attempt]);
  if (onPage !== undefined) return [{ id, kind: "ready", entry: onPage }, () => undefined];
  return [loaded.id === id ? loaded : { id, kind: "loading" }, () => setAttempt((n) => n + 1)];
}

export function AuditDrawer({
  id,
  rows,
  onClose,
  onStep,
}: {
  /** The open entry's ID (`view`). */
  id: string;
  /** The page's rows, newest first: the stepper moves through them. */
  rows: readonly AuditEntry[];
  onClose: () => void;
  onStep: (id: string) => void;
}) {
  const index = rows.findIndex((row) => row.id === id);
  const [loaded, retry] = useEntry(id, index === -1 ? undefined : rows[index]);
  const title = loaded.kind === "ready" ? wordsOf(loaded.entry.event) : "Staff action";
  const previous = index > 0 ? rows[index - 1] : undefined;
  const next = index !== -1 && index < rows.length - 1 ? rows[index + 1] : undefined;

  let body: ReactNode;
  switch (loaded.kind) {
    case "loading":
      body = <SkeletonSection label="staff action" rows={6} />;
      break;
    case "failed":
      body = (
        <ErrorState
          size="section"
          title="Couldn’t load this staff action"
          description="Check your connection and try again."
          onRetry={retry}
          {...(loaded.requestId === null ? {} : { requestId: loaded.requestId })}
        />
      );
      break;
    case "notFound":
      body = (
        <ErrorState
          size="section"
          title="This staff action isn’t in the audit log"
          description="The link may be wrong. Close this and pick a row from the list."
        />
      );
      break;
    case "ready":
      body = <EntryDetails entry={loaded.entry} />;
      break;
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description="Staff action"
      className={SHEET}
    >
      {index === -1 ? null : (
        <div className="flex items-center gap-1">
          <IconButton
            label="Previous staff action"
            size="sm"
            icon={<CaretLeftIcon />}
            {...(previous === undefined
              ? { disabledReason: "This is the first staff action on this page." }
              : {})}
            onClick={() => {
              if (previous !== undefined) onStep(previous.id);
            }}
          />
          <span className="text-caption text-text-tertiary tabular-nums">
            {`${index + 1} of ${rows.length}`}
          </span>
          <IconButton
            label="Next staff action"
            size="sm"
            icon={<CaretRightIcon />}
            {...(next === undefined
              ? { disabledReason: "This is the last staff action on this page." }
              : {})}
            onClick={() => {
              if (next !== undefined) onStep(next.id);
            }}
          />
        </div>
      )}
      {body}
    </Modal>
  );
}
