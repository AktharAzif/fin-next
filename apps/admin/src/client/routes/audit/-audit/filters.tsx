// AdminAudit's toolbar (the board's TableToolbar) on Fin Admin's shared list layout
// (components/list, S6-33): the quick views (All, My actions, Rejections this week), one menu per
// filter (Staff member, Action, Date; Organisation as a chip only), the active filters as
// removable chips with "Clear filters", and "Copy link". What is the audit log's own lives here:
// what each chip says, the menus' choices and the link's address. Every choice goes into the URL,
// so Back undoes it and a copied link opens the same list.
import {
  DropdownMenu,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@fin/ui";
import { type ReactNode, useState } from "react";
import { CopyLinkButton } from "../../../components/list/CopyLink.tsx";
import { DateRangeDialog } from "../../../components/list/DateRangeDialog.tsx";
import { type FilterChip, FilterChips } from "../../../components/list/FilterChips.tsx";
import { filterTrigger, Picked } from "../../../components/list/FilterMenu.tsx";
import { QuickViews, type QuickView as View } from "../../../components/list/QuickViews.tsx";
import type { AuditPerson } from "./contract.ts";
import { formatDay } from "./format.ts";
import {
  type AuditSearch,
  DATE_LABELS,
  DATE_PRESETS,
  type DatePreset,
  hrefOf,
  items,
  type QuickView,
  toggled,
  withFilter,
  withoutFilters,
} from "./search.ts";
import { ACTION_GROUPS, wordsOf } from "./words.ts";

/** "Date: Last 30 days", "Date: 1 Nov 2026 – 3 Nov 2026", "Date: from 1 Nov 2026". */
export function dateLabel(search: AuditSearch): string | null {
  if (search.date !== undefined) return DATE_LABELS[search.date];
  if (search.from !== undefined && search.to !== undefined) {
    return search.from === search.to
      ? formatDay(search.from)
      : `${formatDay(search.from)} – ${formatDay(search.to)}`;
  }
  if (search.from !== undefined) return `from ${formatDay(search.from)}`;
  if (search.to !== undefined) return `until ${formatDay(search.to)}`;
  return null;
}

/** How a member of staff is named in the filter: "Me", or their address when it is known. */
export function personLabel(
  id: string,
  me: string | null,
  known: ReadonlyMap<string, string>,
): string {
  if (id === me) return "Me";
  return known.get(id) ?? "A member of staff";
}

/** The active filters as chips, each naming its values and removing its whole filter. */
export function filterChips(
  search: AuditSearch,
  me: string | null,
  known: ReadonlyMap<string, string>,
  go: (next: AuditSearch) => void,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const actors = items(search.actor);
  if (actors.length > 0) {
    chips.push({
      id: "actor",
      label: `Staff member: ${actors.map((id) => personLabel(id, me, known)).join(", ")}`,
      onRemove: () => go(withFilter(search, { actor: undefined })),
    });
  }
  const actions = items(search.action);
  if (actions.length > 0) {
    chips.push({
      id: "action",
      label: `Action: ${actions.map(wordsOf).join(", ")}`,
      onRemove: () => go(withFilter(search, { action: undefined })),
    });
  }
  const orgs = items(search.org);
  if (orgs.length > 0) {
    chips.push({
      id: "org",
      label: `Organisation: ${orgs.join(", ")}`,
      onRemove: () => go(withFilter(search, { org: undefined })),
    });
  }
  const date = dateLabel(search);
  if (date !== null) {
    chips.push({
      id: "date",
      label: `Date: ${date}`,
      onRemove: () => go(withFilter(search, { date: undefined, from: undefined, to: undefined })),
    });
  }
  return chips;
}

const VIEWS: readonly View<QuickView>[] = [
  { value: undefined, label: "All" },
  { value: "mine", label: "My actions" },
  { value: "rejections", label: "Rejections this week" },
];

/** The link to this list as it is filtered: no open entry and no page, so it opens at the top. */
export function listLink(origin: string, search: AuditSearch): string {
  const { view: _view, cursor: _cursor, before: _before, ...filters } = search;
  return `${origin}${hrefOf(filters)}`;
}

export function AuditToolbar({
  search,
  me,
  people,
  known,
  origin,
  go,
}: {
  search: AuditSearch;
  /** The viewer's staff ID ("Me"). */
  me: string | null;
  /** The Staff member filter's choices beside "Me". */
  people: readonly AuditPerson[];
  /** Every address this page knows by staff ID, for the chips. */
  known: ReadonlyMap<string, string>;
  origin: string;
  go: (next: AuditSearch) => void;
}): ReactNode {
  const [custom, setCustom] = useState(false);
  const actors = items(search.actor);
  const actions = items(search.action);
  const chips = filterChips(search, me, known, go);
  const datePreset: string =
    search.date ?? (search.from !== undefined || search.to !== undefined ? "custom" : "any");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <QuickViews
          views={VIEWS}
          value={search.show}
          onChoose={(show) => go(withFilter(search, { show }))}
        />
        <CopyLinkButton href={listLink(origin, search)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu trigger={filterTrigger("Staff member", actors.length)} className="w-72">
          <MenuItem
            icon={<Picked on={actors.length === 0} />}
            onSelect={() => go(withFilter(search, { actor: undefined }))}
          >
            Anyone
          </MenuItem>
          {me === null ? null : (
            <MenuItem
              icon={<Picked on={actors.includes(me)} />}
              onSelect={() => go(toggled(search, "actor", me))}
            >
              Me
            </MenuItem>
          )}
          {people.length === 0 ? null : <MenuSeparator />}
          {people
            .filter((person) => person.id !== me)
            .map((person) => (
              <MenuItem
                key={person.id}
                icon={<Picked on={actors.includes(person.id)} />}
                onSelect={() => go(toggled(search, "actor", person.id))}
              >
                {person.email}
              </MenuItem>
            ))}
        </DropdownMenu>
        <DropdownMenu trigger={filterTrigger("Action", actions.length)} className="w-80">
          <MenuItem
            icon={<Picked on={actions.length === 0} />}
            onSelect={() => go(withFilter(search, { action: undefined }))}
          >
            Any action
          </MenuItem>
          {ACTION_GROUPS.map((group) => (
            <MenuGroup key={group.label} label={group.label}>
              {Object.entries(group.events).map(([event, words]) => (
                <MenuItem
                  key={event}
                  icon={<Picked on={actions.includes(event)} />}
                  onSelect={() => go(toggled(search, "action", event))}
                >
                  {words}
                </MenuItem>
              ))}
            </MenuGroup>
          ))}
        </DropdownMenu>
        <DropdownMenu trigger={filterTrigger("Date", datePreset === "any" ? 0 : 1)}>
          <MenuRadioGroup
            label="Date (UTC)"
            value={datePreset}
            onValueChange={(value) => {
              if (value === "custom") {
                setCustom(true);
                return;
              }
              go(
                withFilter(search, {
                  date: value === "any" ? undefined : (value as DatePreset),
                  from: undefined,
                  to: undefined,
                }),
              );
            }}
          >
            {/* A choice closes the menu, as the other filters' menus do. */}
            <MenuRadioItem value="any" closeOnSelect>
              Any time
            </MenuRadioItem>
            {DATE_PRESETS.map((preset) => (
              <MenuRadioItem key={preset} value={preset} closeOnSelect>
                {DATE_LABELS[preset]}
              </MenuRadioItem>
            ))}
            <MenuRadioItem value="custom" closeOnSelect>
              Custom…
            </MenuRadioItem>
          </MenuRadioGroup>
        </DropdownMenu>
        <FilterChips chips={chips} onClear={() => go(withoutFilters(search))} />
      </div>
      {custom ? (
        <DateRangeDialog
          open
          initial={{ from: search.from, to: search.to }}
          onClose={() => setCustom(false)}
          onApply={(range) =>
            go(withFilter(search, { date: undefined, from: range.from, to: range.to }))
          }
        />
      ) : null}
    </div>
  );
}
