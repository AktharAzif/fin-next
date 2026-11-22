// Fin Admin's shared list layout (spec 06 §7.2, S6-33): the results line and paging by cursor
// beside the Table: how many rows match, and Newer and Older, each off when there is nothing that
// way. The cursors are the list's API answer's; the pager only hands them back.
//
// @pendingDesign UR-23: the cursor pager is composed beside @fin/ui's Table from its IconButton
// until the kit's Table pages by cursor.
import { CaretLeftIcon, CaretRightIcon } from "@fin/icons";
import { IconButton } from "@fin/ui";

/** What a list's rows are called: "staff action", "staff actions". */
export interface ListNoun {
  singular: string;
  plural: string;
}

/** "1,234 staff actions", or "10,000 or more staff actions" past the count's cap. */
export function totalLine(total: number, capped: boolean, noun: ListNoun): string {
  if (capped) return `${total.toLocaleString("en-GB")} or more ${noun.plural}`;
  return `${total.toLocaleString("en-GB")} ${total === 1 ? noun.singular : noun.plural}`;
}

export type PageCursor = { cursor: string } | { before: string };

export function CursorPager({
  total,
  capped,
  previous,
  next,
  noun,
  onPage,
}: {
  total: number;
  capped: boolean;
  /** The newer page's cursor, or null when nothing newer matches. */
  previous: string | null;
  /** The older page's cursor, or null when nothing older matches. */
  next: string | null;
  noun: ListNoun;
  onPage: (page: PageCursor) => void;
}) {
  return (
    <nav aria-label="Pagination" className="flex h-table-footer items-center justify-between gap-4">
      <p className="m-0 text-caption text-text-tertiary">{totalLine(total, capped, noun)}</p>
      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          variant="secondary"
          label={`Newer ${noun.plural}`}
          icon={<CaretLeftIcon />}
          disabled={previous === null}
          onClick={() => {
            if (previous !== null) onPage({ before: previous });
          }}
        />
        <IconButton
          size="sm"
          variant="secondary"
          label={`Older ${noun.plural}`}
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
