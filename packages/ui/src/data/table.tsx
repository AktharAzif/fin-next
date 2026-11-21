// The Table family, basics (spec 06 §3.3; the export's Table spec): Table, TableId, TableAmount and
// TablePagination. A native <table>; one row in the Tab order (with its own controls, and no other
// row's), moved with ArrowUp and ArrowDown, Home and End, opened with Enter; rows that open a
// drawer are real links (getRowHref) so they open in a new tab and the drawer is addressable;
// sorted headers carry aria-sort; loading draws
// skeleton rows, refreshing keeps the rows, error keeps the header. Selection, filter menus and
// the narrow two-line layout come with wave 2 (L-SAT-12).
import { ArrowDownIcon, ArrowUpIcon, CaretLeftIcon, CaretRightIcon } from "@fin/icons";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../foundation/button.tsx";
import { CopyField } from "../foundation/copy-field.tsx";
import { Skeleton } from "../foundation/skeleton.tsx";
import { useAnnounceOnMount } from "../lib/announce.ts";
import { cn } from "../lib/cn.ts";
import { ErrorState } from "./error-state.tsx";

export type TableNoun = { singular: string; plural: string };
export type SortDirection = "ascending" | "descending";
export type TableSort = { columnId: string; direction: SortDirection };
export type ColumnWidth = "xs" | "sm" | "md" | "lg" | "xl" | "auto";

export type TableColumn<Row> = {
  id: string;
  /** Sentence case, short: "Amount", "Created (UTC)". */
  header: string;
  kind?: "text" | "number" | "amount" | "id" | "date" | "status" | "actions";
  cell: (row: Row) => ReactNode;
  /** A 20px visual before the content (a flag, a token logo). Decorative. */
  leading?: (row: Row) => ReactNode;
  sortable?: boolean;
  /** The direction a first click sorts by: A–Z for text, newest or largest first otherwise. */
  firstDirection?: SortDirection;
  width?: ColumnWidth;
  /** Dropped below 1280px. */
  hideBelow?: "xl";
  /** Hides the header text visually (it still names the column): the actions column. */
  hideHeader?: boolean;
};

export type TableError = {
  title?: string;
  description?: ReactNode;
  onRetry: () => unknown;
  retrying?: boolean;
  requestId?: string;
  /** When a refresh fails with rows on screen: "Showing results from 10:42." */
  staleNote?: string;
};

export type TableProps<Row> = {
  /** The table's name for screen readers: "Transactions". */
  caption: string;
  noun: TableNoun;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  /** The row's accessible name: the title column's text, then what tells rows apart. */
  getRowLabel: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  getRowHref?: (row: Row) => string;
  activeRowId?: string;
  sort?: TableSort;
  onSortChange?: (sort: TableSort) => void;
  status?: "ready" | "loading" | "refreshing" | "error";
  error?: TableError;
  /** The zero state for a request that succeeded with no rows. */
  empty: ReactNode;
  toolbar?: ReactNode;
  pagination?: TablePaginationProps;
  loadingRows?: number;
  /** Keeps the header in view while <main> scrolls. */
  stickyHeader?: boolean;
  /** What the table sits on, so a sticky header is opaque in the same colour. */
  surface?: "bg" | "surface" | "raised";
  className?: string;
};

const WIDTHS: Record<ColumnWidth, string> = {
  xs: "w-16",
  sm: "w-24",
  md: "w-40",
  lg: "w-60",
  xl: "w-80",
  auto: "",
};

const SURFACES = { bg: "bg-bg", surface: "bg-surface", raised: "bg-surface-raised" } as const;

function alignOf(kind: TableColumn<unknown>["kind"]): string {
  return kind === "number" || kind === "amount" ? "text-right" : "text-left";
}

function nextSort(column: TableColumn<unknown>, sort: TableSort | undefined): TableSort {
  const first =
    column.firstDirection ??
    (column.kind === "text" || column.kind === undefined ? "ascending" : "descending");
  if (sort?.columnId !== column.id) return { columnId: column.id, direction: first };
  return {
    columnId: column.id,
    direction: sort.direction === "ascending" ? "descending" : "ascending",
  };
}

function isInteractive(target: EventTarget | null, row: HTMLElement): boolean {
  let el = target instanceof Element ? target : null;
  while (el !== null && el !== row) {
    if (el.matches("button, input, select, textarea, [role='menuitem'], [data-row-ignore]"))
      return true;
    if (el.matches("a[href]") && !el.hasAttribute("data-row-link")) return true;
    el = el.parentElement;
  }
  return false;
}

/** What can take focus inside a row: links, form controls and anything with a tabindex. */
const ROW_CONTROLS = "a[href], button, input, select, textarea, [tabindex], [contenteditable]";

/**
 * Keeps one row in the Tab order with everything in it (spec 06 §9): the controls inside a row (a
 * TableId's full value and its copy button, a link) are tabbable only in the row that holds the
 * roving focus, so Tab from that row reaches its own controls and the next Tab leaves the table.
 * Each control taken out keeps what it had in data-row-tabindex, and gets it back in the current
 * row. Rows' content is the screens', so this works on the DOM rather than on known components.
 * It is idempotent, and it takes out again a control that React or the SDK made tabbable since.
 */
function rovingControls(rows: readonly (HTMLTableRowElement | null)[], current: number): void {
  rows.forEach((row, index) => {
    if (row === null) return;
    for (const el of row.querySelectorAll<HTMLElement>(ROW_CONTROLS)) {
      const saved = el.getAttribute("data-row-tabindex");
      if (index === current) {
        if (saved === null) continue;
        // Give back what it had, unless something set a new tabindex since it was taken out.
        if (el.getAttribute("tabindex") === "-1") {
          if (saved === "") el.removeAttribute("tabindex");
          else el.setAttribute("tabindex", saved);
        }
        el.removeAttribute("data-row-tabindex");
      } else if (el.tabIndex >= 0) {
        // Not yet taken out, or made tabbable again (a re-render that set its tabindex): keep what
        // it has now, and take it out.
        el.setAttribute("data-row-tabindex", el.getAttribute("tabindex") ?? "");
        el.setAttribute("tabindex", "-1");
      }
    }
  });
}

function LoadingNote(props: { plural: string }) {
  useAnnounceOnMount(`Loading ${props.plural}`);
  return null;
}

export function Table<Row>(props: TableProps<Row>) {
  const status = props.status ?? "ready";
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const activeIndex = props.rows.findIndex((r) => props.getRowId(r) === props.activeRowId);
  const [focusIndex, setFocusIndex] = useState(Math.max(0, activeIndex));
  useEffect(() => {
    if (focusIndex >= props.rows.length) setFocusIndex(Math.max(0, props.rows.length - 1));
  }, [focusIndex, props.rows.length]);
  const opens = props.onRowClick !== undefined || props.getRowHref !== undefined;
  // Only when rows take focus; otherwise the controls stay in the Tab order, the only way to reach
  // them. After every render (rows, sorting or the current row may have changed), and whenever the
  // body's content changes without one (a cell that mounts a control from its own state, or sets a
  // tabindex again), through the latest render's rows.
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const applyRoving = useRef<() => void>(() => {});
  useEffect(() => {
    applyRoving.current = () => {
      if (opens) rovingControls(rowRefs.current.slice(0, props.rows.length), focusIndex);
    };
    applyRoving.current();
  });
  useEffect(() => {
    const body = bodyRef.current;
    if (!opens || body === null || typeof MutationObserver === "undefined") return;
    // Its own changes call it once more, which changes nothing (rovingControls is idempotent).
    const observer = new MutationObserver(() => applyRoving.current());
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["tabindex"],
    });
    return () => observer.disconnect();
  }, [opens]);

  const open = (row: Row, event?: MouseEvent | KeyboardEvent) => {
    if (props.onRowClick !== undefined) {
      event?.preventDefault();
      props.onRowClick(row);
      return;
    }
    if (props.getRowHref !== undefined && typeof window !== "undefined") {
      window.location.assign(props.getRowHref(row));
    }
  };

  const move = (index: number) => {
    const target = Math.min(Math.max(index, 0), props.rows.length - 1);
    setFocusIndex(target);
    rowRefs.current[target]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: Row) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(props.rows.length - 1);
    else if (event.key === "Enter") open(row, event);
    else return;
    event.preventDefault();
  };

  const span = props.columns.length;
  const surface = SURFACES[props.surface ?? "bg"];

  let body: ReactNode;
  if (status === "loading") {
    body = Array.from(
      { length: props.loadingRows ?? props.pagination?.pageSize ?? 8 },
      (_, i) => `l${i}`,
    ).map((key) => (
      <tr key={key} data-skeleton-row="" className="h-row border-b border-border">
        {props.columns.map((column) => (
          <td
            key={column.id}
            aria-hidden="true"
            className={cn("px-4", column.hideBelow === "xl" && "hidden xl:table-cell")}
          >
            <Skeleton
              {...(column.kind === "status" ? { shape: "badge" as const } : {})}
              className={
                column.kind === "amount" || column.kind === "number" ? "ml-auto w-20" : "w-3/4"
              }
            />
          </td>
        ))}
      </tr>
    ));
  } else if (status === "error" && props.rows.length === 0) {
    body = (
      <tr>
        <td colSpan={span}>
          <ErrorState
            title={props.error?.title ?? `Couldn’t load ${props.noun.plural}`}
            {...(props.error?.description === undefined
              ? {}
              : { description: props.error.description })}
            {...(props.error === undefined ? {} : { onRetry: props.error.onRetry })}
            {...(props.error?.retrying === undefined ? {} : { retrying: props.error.retrying })}
            {...(props.error?.requestId === undefined ? {} : { requestId: props.error.requestId })}
          />
        </td>
      </tr>
    );
  } else if (props.rows.length === 0) {
    body = (
      <tr>
        <td colSpan={span}>{props.empty}</td>
      </tr>
    );
  } else {
    body = props.rows.map((row, index) => {
      const id = props.getRowId(row);
      const active = id === props.activeRowId;
      const href = props.getRowHref?.(row);
      return (
        <tr
          key={id}
          ref={(el) => {
            rowRefs.current[index] = el;
          }}
          data-row-id={id}
          data-active={active ? "" : undefined}
          aria-label={props.getRowLabel(row)}
          {...(opens ? { tabIndex: index === focusIndex ? 0 : -1 } : {})}
          onFocus={() => setFocusIndex(index)}
          onKeyDown={opens ? (event) => onKeyDown(event, index, row) : undefined}
          onClick={
            opens
              ? (event) => {
                  if (isInteractive(event.target, event.currentTarget)) return;
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  open(row, event);
                }
              : undefined
          }
          className={cn(
            "h-row border-b border-border text-body text-text-primary outline-none",
            opens && "cursor-pointer hover:bg-fill-hover focus-visible:outline-focus-inset",
            active && "bg-fill-selected hover:bg-fill-selected",
          )}
        >
          {props.columns.map((column, ci) => {
            const content = column.cell(row);
            const leading = column.leading?.(row);
            const inner =
              ci === 0 && href !== undefined ? (
                <a href={href} tabIndex={-1} data-row-link="" className="text-inherit no-underline">
                  {content}
                </a>
              ) : (
                content
              );
            return (
              <td
                key={column.id}
                className={cn(
                  "px-4 py-0 align-middle",
                  alignOf(column.kind),
                  (column.kind === "amount" ||
                    column.kind === "number" ||
                    column.kind === "date") &&
                    "tabular-nums whitespace-nowrap",
                  column.hideBelow === "xl" && "hidden xl:table-cell",
                  WIDTHS[column.width ?? "auto"],
                )}
              >
                {leading === undefined ? (
                  inner
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden="true" className="inline-flex">
                      {leading}
                    </span>
                    {inner}
                  </span>
                )}
              </td>
            );
          })}
        </tr>
      );
    });
  }

  return (
    <div data-slot="table" className={cn("flex flex-col gap-4", props.className)}>
      {props.toolbar}
      {status === "loading" ? <LoadingNote plural={props.noun.plural} /> : null}
      <div className={cn(!props.stickyHeader && "overflow-x-auto")}>
        <table
          aria-busy={status === "loading" || status === "refreshing" ? true : undefined}
          aria-rowcount={
            status === "ready" || status === "refreshing" ? props.rows.length + 1 : undefined
          }
          className="w-full border-collapse"
        >
          <caption className="sr-only">{props.caption}</caption>
          <thead className={cn(props.stickyHeader && cn("sticky top-0 z-sticky", surface))}>
            <tr className="h-table-header border-b border-border">
              {props.columns.map((column) => {
                const sorted =
                  props.sort?.columnId === column.id ? props.sort.direction : undefined;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    {...(sorted === undefined ? {} : { "aria-sort": sorted })}
                    className={cn(
                      "px-4 text-caption font-medium whitespace-nowrap text-text-tertiary",
                      alignOf(column.kind),
                      column.hideBelow === "xl" && "hidden xl:table-cell",
                      WIDTHS[column.width ?? "auto"],
                    )}
                  >
                    {column.sortable === true && props.onSortChange !== undefined ? (
                      <button
                        type="button"
                        onClick={() =>
                          props.onSortChange?.(nextSort(column as TableColumn<unknown>, props.sort))
                        }
                        className="inline-flex cursor-pointer items-center gap-1 rounded-xs bg-transparent p-0 text-caption font-medium text-text-tertiary hover:text-text-primary focus-visible:outline-focus"
                      >
                        {column.header}
                        {sorted === "ascending" ? <ArrowUpIcon size={12} /> : null}
                        {sorted === "descending" ? <ArrowDownIcon size={12} /> : null}
                      </button>
                    ) : (
                      <span className={cn(column.hideHeader === true && "sr-only")}>
                        {column.header}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef}>{body}</tbody>
        </table>
      </div>
      {status === "refreshing" ? (
        <p className="m-0 text-caption text-text-tertiary">{`Updating ${props.noun.plural}`}</p>
      ) : null}
      {status === "error" && props.rows.length > 0 ? (
        <ErrorState
          size="inline"
          title={props.error?.title ?? `Couldn’t refresh ${props.noun.plural}`}
          description={props.error?.staleNote ?? "Check your connection and try again."}
          {...(props.error === undefined ? {} : { onRetry: props.error.onRetry })}
          {...(props.error?.retrying === undefined ? {} : { retrying: props.error.retrying })}
        />
      ) : null}
      {props.pagination === undefined || status === "loading" ? null : (
        <TablePagination {...props.pagination} noun={props.pagination.noun ?? props.noun} />
      )}
    </div>
  );
}

/** An ID in a cell: mono, middle-truncated, with its copy button; 32px tall. */
export function TableId(props: { value: string; label: string }) {
  return <CopyField value={props.value} label={props.label} className="h-8" />;
}

/** Minor units as major ones: 1250000 and USD is "12,500.00 USD", the code in text-tertiary. */
export function formatMinor(minor: number | bigint | string, decimals = 2): string {
  const digits = String(minor).trim();
  if (!/^-?\d+$/.test(digits)) throw new Error("minor units are a whole number");
  const negative = digits.startsWith("-");
  const raw = (negative ? digits.slice(1) : digits).padStart(decimals + 1, "0");
  const whole = raw.slice(0, raw.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = decimals > 0 ? `.${raw.slice(raw.length - decimals)}` : "";
  return `${negative ? "−" : ""}${whole}${fraction}`;
}

export function TableAmount(props: {
  minor: number | bigint | string;
  currency: string;
  decimals?: number;
}) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      {formatMinor(props.minor, props.decimals ?? 2)}{" "}
      <span className="text-text-tertiary">{props.currency}</span>
    </span>
  );
}

export type TablePaginationProps = {
  /** 1-based. */
  page: number;
  pageCount: number;
  total?: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
  noun?: TableNoun;
};

export function TablePagination(props: TablePaginationProps) {
  const noun = props.noun ?? { singular: "row", plural: "rows" };
  let summary = `Page ${props.page} of ${Math.max(1, props.pageCount)}`;
  if (props.total !== undefined && props.pageSize !== undefined && props.total > 0) {
    const from = (props.page - 1) * props.pageSize + 1;
    const to = Math.min(props.total, props.page * props.pageSize);
    summary = `${from.toLocaleString("en-GB")}–${to.toLocaleString("en-GB")} of ${props.total.toLocaleString("en-GB")} ${props.total === 1 ? noun.singular : noun.plural}`;
  }
  return (
    <nav aria-label="Pagination" className="flex h-table-footer items-center justify-between gap-4">
      <p className="m-0 text-caption text-text-tertiary">{summary}</p>
      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          variant="secondary"
          label="Previous page"
          icon={<CaretLeftIcon />}
          disabled={props.page <= 1}
          onClick={() => props.onPageChange(props.page - 1)}
        />
        <IconButton
          size="sm"
          variant="secondary"
          label="Next page"
          icon={<CaretRightIcon />}
          disabled={props.page >= props.pageCount}
          onClick={() => props.onPageChange(props.page + 1)}
        />
      </div>
    </nav>
  );
}
