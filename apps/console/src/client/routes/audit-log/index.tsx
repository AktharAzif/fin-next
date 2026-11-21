// Audit log (AuditLog board; spec 02 §14.2, §14.5, §15.2, §15.2.1): the organisation's sensitive
// actions, newest first, read through `api`'s door. Search, the type pills, the range menu and
// one object's filter (from the entry points on Team, Roles and the role editor) live in the URL;
// a row opens its entry (`view=<aud_…>`). An object that matches nothing in this organisation
// draws "No events match", never an error that would say whether it exists. Needs
// `auditLog.read` (the frame draws the no-permission state without it; the server refuses).
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { CaretDownIcon, ClockCounterClockwiseIcon, MagnifyingGlassIcon, XIcon } from "@fin/icons";
import {
  Avatar,
  Badge,
  Button,
  CopyField,
  DropdownMenu,
  EmptyState,
  Field,
  Input,
  MenuRadioGroup,
  MenuRadioItem,
  Modal,
  PageHeader,
  Table,
  type TableColumn,
} from "@fin/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type AuditRange, type AuditRow, auditLog } from "../../api/contracts/audit.ts";
import { useResource } from "../../api/resource.ts";
import {
  AUDIT_TYPES,
  type AuditSearch,
  auditQuery,
  DEFAULT_RANGE,
  emptyKind,
  objectChip,
  PAGE_SIZE,
  RANGE_LABELS,
  readAuditSearch,
} from "../../audit/filters.ts";
import {
  actorName,
  categoryLabel,
  describe,
  sentenceText,
  verifiedLabel,
} from "../../audit/sentences.ts";
import { AuditSentence, AuditWhere, VerifiedChip, whereLine } from "../../components/audit.tsx";
import { useSignedIn } from "../../components/page.tsx";
import { formatFull, formatShort } from "../../format/dates.ts";

export const Route = createFileRoute("/audit-log/")({
  staticData: {
    frame: "app",
    navId: "audit-log",
    pageName: "Audit log",
    needs: ["auditLog.read"],
  },
  validateSearch: readAuditSearch,
  pendingComponent: AuditLoading,
  component: AuditLogPage,
});

function description(organisation: string | null): string {
  return `Every sensitive action in ${organisation ?? "this organisation"}: who did it, to what, and how they were verified. Entries can’t be edited or removed.`;
}

function AuditLoading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Audit log" description={description(null)} linkAs={RouterLink} />
      <Table
        caption="Audit log"
        noun={{ singular: "event", plural: "events" }}
        columns={[{ id: "event", header: "Event", cell: () => null }]}
        rows={[]}
        getRowId={() => ""}
        getRowLabel={() => ""}
        status="loading"
        loadingRows={9}
        empty={null}
      />
    </div>
  );
}

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function AuditLogPage() {
  const fin = useFin<ConsoleViewer>();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const search = Route.useSearch();
  const orgId = signedIn?.viewer.currentOrgId ?? "";
  const query = auditQuery(search, timeZone());
  const log = useResource(`audit:${orgId}:${JSON.stringify(query)}`, (signal) =>
    fin.api(auditLog, query, { signal }),
  );
  const [typed, setTyped] = useState(search.q ?? "");
  const q = search.q ?? "";

  const go = (next: AuditSearch, replace = true) =>
    navigate({ to: "/audit-log", search: next, replace });

  // Typing settles for 300 ms before the search goes into the URL (and to the API).
  useEffect(() => {
    const value = typed.trim();
    if (value === q) return;
    const timer = setTimeout(() => {
      const { q: _old, page: _page, ...rest } = search;
      void go(value === "" ? rest : { ...rest, q: value });
    }, 300);
    return () => clearTimeout(timer);
  });

  const rows = log.data?.items ?? [];
  const total = log.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const chip = objectChip(search, log.data?.filterLabel);
  const range = search.range ?? DEFAULT_RANGE;
  const open =
    search.view === undefined ? null : (rows.find((row) => row.id === search.view) ?? null);
  const you = signedIn?.viewer.user.id ?? null;

  const without = (...keys: (keyof AuditSearch)[]): AuditSearch => {
    const next: AuditSearch = { ...search };
    for (const key of keys) delete next[key];
    delete next.page;
    delete next.view;
    return next;
  };

  const columns: TableColumn<AuditRow>[] = [
    {
      id: "event",
      header: "Event",
      cell: (row) => (
        <div className="flex min-w-0 items-start gap-3 py-2">
          <Avatar name={row.actor.name ?? ""} email={row.actor.email ?? ""} size={24} />
          <div className="flex min-w-0 flex-col">
            <AuditSentence row={row} you={you} />
            <AuditWhere row={row} />
          </div>
        </div>
      ),
    },
    {
      id: "verified",
      header: "Verified by",
      width: "md",
      hideBelow: "xl",
      cell: (row) => <VerifiedChip verification={row.verification} />,
    },
    {
      id: "when",
      header: "Time (UTC)",
      kind: "date",
      width: "md",
      cell: (row) => formatShort(row.at),
    },
  ];

  const kind = emptyKind(search);
  const filters = [
    ...(search.type === undefined
      ? []
      : [
          {
            id: "type",
            label: `Type: ${categoryLabel(search.type)}`,
            onRemove: () => void go(without("type")),
          },
        ]),
    ...(chip === null
      ? []
      : [{ id: "object", label: chip, onRemove: () => void go(without("target", "targetKind")) }]),
    ...(range === DEFAULT_RANGE
      ? []
      : [{ id: "range", label: RANGE_LABELS[range], onRemove: () => void go(without("range")) }]),
  ];
  const empty =
    kind === "noMatch" ? (
      <EmptyState
        variant="no-results"
        title="No events match"
        description={
          q === ""
            ? `Nothing ${chip === null ? "" : `for ${chip} `}over ${RANGE_LABELS[range].toLowerCase()}.`
            : `Nothing for “${q}” over ${RANGE_LABELS[range].toLowerCase()}.`
        }
        filters={filters}
        onClearFilters={() => {
          setTyped("");
          void go({});
        }}
      />
    ) : kind === "range" ? (
      <EmptyState
        variant="no-results"
        title={`No events in the ${RANGE_LABELS[range].toLowerCase().replace(/^last /, "last ")}`}
        description="Older events are still kept."
        action={
          <Button variant="secondary" size="sm" onClick={() => go({ ...without(), range: "all" })}>
            Show all time
          </Button>
        }
      />
    ) : (
      <EmptyState
        variant="first-use"
        icon={<ClockCounterClockwiseIcon />}
        title="No events yet"
        description="Sensitive actions show here as they happen."
      />
    );

  const toolbar = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full max-w-80">
          <Field label="Search the audit log" hideLabel>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-tertiary">
                <MagnifyingGlassIcon />
              </span>
              <Input
                type="search"
                value={typed}
                placeholder="Search a person, key or address"
                className="pl-9"
                onValueChange={(value) => setTyped(value)}
              />
            </div>
          </Field>
        </div>
        <DropdownMenu
          trigger={
            <Button variant="secondary" size="sm" trailingIcon={<CaretDownIcon />}>
              {RANGE_LABELS[range]}
            </Button>
          }
        >
          <MenuRadioGroup
            label="Time"
            value={range}
            onValueChange={(value) => void go({ ...without("range"), range: value as AuditRange })}
          >
            {(Object.keys(RANGE_LABELS) as AuditRange[]).map((value) => (
              <MenuRadioItem key={value} value={value}>
                {RANGE_LABELS[value]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </DropdownMenu>
      </div>
      {/* @pendingDesign UR-23: FilterChips in @fin/ui (the board's "Type of event" pills). */}
      <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">Type of event</legend>
        {[{ value: undefined, label: "All" }, ...AUDIT_TYPES].map((type) => {
          const pressed = search.type === type.value;
          return (
            <Button
              key={type.label}
              variant={pressed ? "primary" : "secondary"}
              size="sm"
              aria-pressed={pressed}
              onClick={() =>
                go(
                  type.value === undefined
                    ? without("type")
                    : { ...without("type"), type: type.value },
                )
              }
            >
              {type.label}
            </Button>
          );
        })}
        {chip === null ? null : (
          <button
            type="button"
            onClick={() => go(without("target", "targetKind"))}
            aria-label={`Remove filter: ${chip}`}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control bg-fill-selected px-3 text-label-sm text-text-secondary hover:text-text-primary focus-visible:outline-focus"
          >
            {chip}
            <XIcon size={12} />
          </button>
        )}
      </fieldset>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description={description(signedIn?.membership?.name ?? null)}
        linkAs={RouterLink}
      />
      <Table
        caption="Audit log"
        noun={{ singular: "event", plural: "events" }}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) =>
          `${sentenceText(describe(row, you))}, ${formatShort(row.at)} UTC${
            verifiedLabel(row.verification) === null ? "" : `, ${verifiedLabel(row.verification)}`
          }`
        }
        onRowClick={(row) => go({ ...search, view: row.id }, false)}
        {...(open === null ? {} : { activeRowId: open.id })}
        status={
          log.status === "loading"
            ? "loading"
            : log.status === "refreshing"
              ? "refreshing"
              : log.status === "error"
                ? "error"
                : "ready"
        }
        error={{
          title: "Couldn’t load the audit log",
          description: "Check your connection and try again.",
          onRetry: log.reload,
        }}
        toolbar={toolbar}
        empty={empty}
        loadingRows={9}
        {...(rows.length === 0
          ? {}
          : {
              pagination: {
                page: search.page ?? 1,
                pageCount,
                total,
                pageSize: PAGE_SIZE,
                onPageChange: (page: number) =>
                  void go(page <= 1 ? without("page") : { ...without(), page }, false),
              },
            })}
      />
      {open === null ? null : (
        <EntryDialog
          row={open}
          you={you}
          onClose={() => {
            const { view: _view, ...rest } = search;
            void go(rest);
          }}
        />
      )}
    </div>
  );
}

/** An entry's details (the board's drawer). @pendingDesign UR-24: a Drawer in @fin/ui. */
function EntryDialog({
  row,
  you,
  onClose,
}: {
  row: AuditRow;
  you: string | null;
  onClose: () => void;
}) {
  const sentence = describe(row, you);
  const where = whereLine(row);
  const verified = verifiedLabel(row.verification);
  const title = `${sentence.verb.charAt(0).toUpperCase()}${sentence.verb.slice(1)}${
    sentence.object === null ? "" : ` ${sentence.object}`
  }${sentence.tail}`;
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={`${categoryLabel(row.category)}${row.category === undefined ? "" : " · "}${formatFull(row.at)}. An entry can’t be edited or removed.`}
    >
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-body">
        <dt className="text-text-secondary">Who</dt>
        <dd className="m-0 flex flex-col">
          <span className="text-text-primary">{actorName(row)}</span>
          {row.actor.email ? (
            <span className="text-caption text-text-tertiary">{row.actor.email}</span>
          ) : null}
          {row.actor.roleLabel ? (
            <span className="text-caption text-text-tertiary">{row.actor.roleLabel}</span>
          ) : null}
        </dd>
        <dt className="text-text-secondary">Action</dt>
        <dd className="m-0 text-text-primary">{sentence.verb}</dd>
        {row.target === null || row.target === undefined ? null : (
          <>
            <dt className="text-text-secondary">Object</dt>
            <dd className="m-0 flex flex-col gap-1">
              {row.target.label ? (
                <span className="text-text-primary">{row.target.label}</span>
              ) : null}
              <CopyField value={row.target.id} label="Object ID" />
            </dd>
          </>
        )}
        <dt className="text-text-secondary">Verified by</dt>
        <dd className="m-0">
          {verified === null ? "—" : <Badge variant="secondary">{verified}</Badge>}
        </dd>
        {where === null ? null : (
          <>
            <dt className="text-text-secondary">From</dt>
            <dd className="m-0 text-text-primary tabular-nums">{where}</dd>
          </>
        )}
        <dt className="text-text-secondary">When</dt>
        <dd className="m-0 text-text-primary">{formatFull(row.at)}</dd>
        <dt className="text-text-secondary">Entry ID</dt>
        <dd className="m-0">
          <CopyField value={row.id} label="Entry ID" />
        </dd>
      </dl>
    </Modal>
  );
}
