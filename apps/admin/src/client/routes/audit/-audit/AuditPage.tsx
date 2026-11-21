// Audit log (AdminAudit board; spec 02 §14.3, §14.5, §16.4; spec 06 §7.2): everything Fin's staff
// and the system did here, newest first, read through `GET /api/audit`. The quick views, the
// filters and the page's cursor live in the URL; a row opens its entry in the drawer
// (`view=<aud_…>`), and a link to an entry opens it on arrival. Needs `audit.read` (the frame
// draws the no-permission state without it; the server refuses regardless).
import type { StaffViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { CaretLeftIcon, CaretRightIcon, ClockCounterClockwiseIcon } from "@fin/icons";
import {
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  Skeleton,
  Table,
  type TableColumn,
} from "@fin/ui";
import { useState } from "react";
import { AuditDrawer } from "./AuditDrawer.tsx";
import type { AuditEntry, AuditPerson } from "./contract.ts";
import { AuditToolbar, filterChips } from "./filters.tsx";
import { formatWhen } from "./format.ts";
import type { AuditData } from "./load.ts";
import {
  type AuditSearch,
  emptyKind,
  hrefOf,
  paged,
  withFilter,
  withoutFilters,
} from "./search.ts";
import { reasonOf, targetText, whoOf, wordsOf } from "./words.ts";

export const AUDIT_DESCRIPTION = "Everything Fin’s staff have done here, newest first.";
const NOUN = { singular: "staff action", plural: "staff actions" } as const;

/** The ID as the What column shows it: whole when short, else its ends. */
export function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
}

/** The row's accessible name: what, to what, who and when. */
export function rowLabel(entry: AuditEntry): string {
  return `${wordsOf(entry.event)}, ${targetText(entry)}, ${whoOf(entry)}, ${formatWhen(entry.at)} UTC`;
}

export function auditColumns(): TableColumn<AuditEntry>[] {
  return [
    {
      id: "what",
      header: "What",
      width: "xl",
      cell: (entry) => (
        <div className="flex min-w-0 flex-col items-start py-2">
          <span className="text-label text-text-primary">{wordsOf(entry.event)}</span>
          <span className="hidden truncate font-mono text-caption text-text-tertiary lg:block">
            {shortId(targetText(entry))}
          </span>
        </div>
      ),
    },
    {
      id: "who",
      header: "Who",
      width: "lg",
      cell: (entry) => <span className="block truncate text-label">{whoOf(entry)}</span>,
    },
    {
      id: "org",
      header: "Organisation",
      width: "lg",
      hideBelow: "xl",
      cell: (entry) =>
        entry.organisationId === null ? (
          <span className="text-text-tertiary">None</span>
        ) : (
          <span className="block truncate font-mono text-caption">
            {shortId(entry.organisationId)}
          </span>
        ),
    },
    {
      id: "reason",
      header: "Reason",
      cell: (entry) => {
        const reason = reasonOf(entry);
        return reason === null ? (
          <span className="text-text-tertiary">No reason asked</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-baseline gap-2 py-2">
            <span>{reason.words}</span>
            <span className="font-mono text-caption text-text-tertiary">{reason.code}</span>
          </span>
        );
      },
    },
    {
      id: "when",
      header: "When (UTC)",
      kind: "date",
      width: "lg",
      cell: (entry) => formatWhen(entry.at),
    },
  ];
}

/** The columns with no cells, for the loading and failed tables. */
function emptyColumns(): TableColumn<AuditEntry>[] {
  return auditColumns().map((column) => ({ ...column, cell: () => null }));
}

/** The page before its first answer: the header, the toolbar's shapes and the loading rows. */
export function AuditSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Audit log" description={AUDIT_DESCRIPTION} linkAs={RouterLink} />
      <Table
        caption="Audit log"
        noun={NOUN}
        columns={emptyColumns()}
        rows={[]}
        getRowId={() => ""}
        getRowLabel={() => ""}
        status="loading"
        loadingRows={8}
        empty={null}
        toolbar={
          <div aria-hidden="true" className="flex items-center gap-2 overflow-hidden">
            {["w-14", "w-24", "w-40"].map((width) => (
              <Skeleton key={width} shape="control" className={`${width} shrink-0`} />
            ))}
          </div>
        }
      />
    </div>
  );
}

/** "1,234 staff actions", or "10,000 or more staff actions" past the count's cap. */
export function totalLine(total: number, capped: boolean): string {
  if (capped) return `${total.toLocaleString("en-GB")} or more staff actions`;
  return `${total.toLocaleString("en-GB")} ${total === 1 ? "staff action" : "staff actions"}`;
}

function Pager({
  total,
  capped,
  previous,
  next,
  onPage,
}: {
  total: number;
  capped: boolean;
  previous: string | null;
  next: string | null;
  onPage: (page: { cursor: string } | { before: string }) => void;
}) {
  return (
    <nav aria-label="Pagination" className="flex h-table-footer items-center justify-between gap-4">
      <p className="m-0 text-caption text-text-tertiary">{totalLine(total, capped)}</p>
      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          variant="secondary"
          label="Newer staff actions"
          icon={<CaretLeftIcon />}
          disabled={previous === null}
          onClick={() => {
            if (previous !== null) onPage({ before: previous });
          }}
        />
        <IconButton
          size="sm"
          variant="secondary"
          label="Older staff actions"
          icon={<CaretRightIcon />}
          disabled={next === null}
          onClick={() => {
            if (next !== null) onPage({ cursor: next });
          }}
        />
      </div>
    </nav>
  );
}

/** The addresses this page knows by staff ID: the filter's people and the rows' actors. */
function knownPeople(people: readonly AuditPerson[], rows: readonly AuditEntry[]) {
  const known = new Map<string, string>();
  for (const person of people) known.set(person.id, person.email);
  for (const row of rows) {
    if (row.actor.kind === "staff" && row.actor.id !== null && row.actor.email !== null) {
      known.set(row.actor.id, row.actor.email);
    }
  }
  return known;
}

/** The Staff member filter's choices: the people sent, else those acting on this page. */
function choices(people: readonly AuditPerson[], rows: readonly AuditEntry[]): AuditPerson[] {
  if (people.length > 0) return [...people];
  const seen = knownPeople([], rows);
  return [...seen.entries()]
    .map(([id, email]) => ({ id, email }))
    .sort((a, b) => a.email.localeCompare(b.email, "en-GB"));
}

export function AuditPage({
  data,
  search,
  go,
  onReload,
}: {
  data: AuditData;
  search: AuditSearch;
  /** Moves to another search; `push` adds a history entry (opening an entry), else replaces. */
  go: (next: AuditSearch, push?: boolean) => void;
  onReload: () => Promise<void>;
}) {
  const fin = useFin<StaffViewer>();
  const viewer = fin.viewer.get();
  const [retrying, setRetrying] = useState(false);
  // Whether this tab opened the entry, so closing it goes Back rather than adding a step.
  const [openedHere, setOpenedHere] = useState(false);
  if (viewer?.state !== "ok" || data.kind === "notAllowed") return null;
  const me = viewer.staff.id;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const rows = data.kind === "ready" ? data.page.items : [];
  const people = data.kind === "ready" ? data.page.people : [];
  const known = knownPeople(people, rows);
  const toolbar = (
    <AuditToolbar
      search={search}
      me={me}
      people={choices(people, rows)}
      known={known}
      origin={origin}
      go={(next) => go(next)}
    />
  );

  const header = (
    <PageHeader title="Audit log" description={AUDIT_DESCRIPTION} linkAs={RouterLink} />
  );

  if (data.kind === "failed") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Table
          caption="Audit log"
          noun={NOUN}
          columns={emptyColumns()}
          rows={[]}
          getRowId={() => ""}
          getRowLabel={() => ""}
          status="error"
          toolbar={toolbar}
          error={{
            title: "Couldn’t load the audit log",
            // A read changes nothing: it says so, and never that something went through.
            description: data.offline
              ? "Check your connection and try again."
              : "Something went wrong on our side. Nothing was changed.",
            retrying,
            onRetry: async () => {
              setRetrying(true);
              try {
                await onReload();
              } finally {
                setRetrying(false);
              }
            },
            ...(data.requestId === null ? {} : { requestId: data.requestId }),
          }}
          empty={null}
        />
      </div>
    );
  }

  const page = data.page;
  const kind = emptyKind(search);
  const empty =
    kind === "firstUse" ? (
      <EmptyState
        variant="first-use"
        icon={<ClockCounterClockwiseIcon />}
        title="No staff actions yet"
        description="Everything Fin’s staff do here appears in this log."
      />
    ) : kind === "viewEmpty" ? (
      <EmptyState
        variant="no-results"
        title={
          search.show === "mine" ? "You haven’t done anything here yet" : "No rejections this week"
        }
        description={
          search.show === "mine"
            ? "What you do in Fin Admin appears here."
            : "Nobody here has rejected a customer since Monday."
        }
        action={
          <Button size="sm" onClick={() => go(withFilter(search, { show: undefined }))}>
            Show every action
          </Button>
        }
      />
    ) : (
      <EmptyState
        variant="no-results"
        title="No staff actions match these filters"
        description="Remove a filter or clear them all."
        filters={filterChips(search, me, known, (next) => go(next))}
        onClearFilters={() => go(withoutFilters(search))}
      />
    );
  // The first-use state has nothing to filter: no toolbar, as the board draws it.
  const firstUse = rows.length === 0 && kind === "firstUse" && search.cursor === undefined;

  const close = () => {
    if (openedHere && typeof window !== "undefined") {
      setOpenedHere(false);
      window.history.back();
      return;
    }
    const { view: _view, ...rest } = search;
    go(rest);
  };

  return (
    <div className="flex flex-col gap-6">
      {header}
      <Table
        caption="Audit log"
        noun={NOUN}
        columns={auditColumns()}
        rows={rows}
        getRowId={(entry) => entry.id}
        getRowLabel={rowLabel}
        getRowHref={(entry) => hrefOf({ ...search, view: entry.id })}
        onRowClick={(entry) => {
          setOpenedHere(true);
          go({ ...search, view: entry.id }, true);
        }}
        {...(search.view === undefined ? {} : { activeRowId: search.view })}
        status="ready"
        empty={empty}
        {...(firstUse ? {} : { toolbar })}
      />
      {rows.length === 0 ? null : (
        <Pager
          total={page.total}
          capped={page.totalCapped}
          previous={page.previousCursor}
          next={page.nextCursor}
          onPage={(cursor) => go(paged(search, cursor), true)}
        />
      )}
      {search.view === undefined ? null : (
        <AuditDrawer
          id={search.view}
          rows={rows}
          onClose={close}
          onStep={(id) => go({ ...search, view: id })}
        />
      )}
    </div>
  );
}
