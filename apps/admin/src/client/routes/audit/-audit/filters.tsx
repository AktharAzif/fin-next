// AdminAudit's toolbar (the board's TableToolbar): the quick views (All, My actions, Rejections
// this week), one menu per filter (Staff member, Action, Date; Organisation as a chip only), the
// active filters as removable chips with "Clear filters", and "Copy link". Every choice goes into
// the URL, so Back undoes it and a copied link opens the same list.
//
// @pendingDesign UR-23: FilterChips, FilterMenu, TableToolbar and DateRangePicker are not in
// @fin/ui yet; they are composed here from its Button, DropdownMenu, Modal and Field, and swap for
// the kit's when it has them. Each menu choice toggles one value and closes the menu.
import { CaretDownIcon, CheckIcon, CopyIcon, XIcon } from "@fin/icons";
import {
  Button,
  DropdownMenu,
  Field,
  Input,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  Modal,
  toast,
} from "@fin/ui";
import { type ReactNode, useState } from "react";
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

export interface FilterChip {
  id: "actor" | "action" | "org" | "date";
  label: string;
  onRemove: () => void;
}

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

const VIEWS: readonly { value: QuickView | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "mine", label: "My actions" },
  { value: "rejections", label: "Rejections this week" },
];

function Picked({ on }: { on: boolean }) {
  return on ? <CheckIcon /> : <span aria-hidden="true" className="inline-block size-4" />;
}

/**
 * One filter's trigger: its name, and how many values it holds. The Button element itself, never
 * a component around it: the menu gives its trigger the props that open it.
 */
function trigger(label: string, count: number) {
  return (
    <Button variant="secondary" size="sm" trailingIcon={<CaretDownIcon />}>
      {count === 0 ? label : `${label} (${count})`}
    </Button>
  );
}

/** The link to this list as it is filtered: no open entry and no page, so it opens at the top. */
export function listLink(origin: string, search: AuditSearch): string {
  const { view: _view, cursor: _cursor, before: _before, ...filters } = search;
  return `${origin}${hrefOf(filters)}`;
}

function CustomDates({
  open,
  search,
  onClose,
  go,
}: {
  open: boolean;
  search: AuditSearch;
  onClose: () => void;
  go: (next: AuditSearch) => void;
}) {
  const [from, setFrom] = useState(search.from ?? "");
  const [to, setTo] = useState(search.to ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Custom dates"
      description="Days in UTC. Both days are included."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (from === "" && to === "") {
                setError("Choose a first day, a last day, or both.");
                return;
              }
              if (from !== "" && to !== "" && from > to) {
                setError("The last day can’t be before the first.");
                return;
              }
              go(
                withFilter(search, {
                  date: undefined,
                  from: from === "" ? undefined : from,
                  to: to === "" ? undefined : to,
                }),
              );
              onClose();
            }}
          >
            Show these days
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First day" optional>
          <Input type="date" value={from} onValueChange={(value) => setFrom(String(value))} />
        </Field>
        <Field label="Last day" optional {...(error === null ? {} : { error })}>
          <Input type="date" value={to} onValueChange={(value) => setTo(String(value))} />
        </Field>
      </div>
    </Modal>
  );
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
        <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
          <legend className="sr-only">Views</legend>
          {VIEWS.map((view) => {
            const pressed = search.show === view.value;
            return (
              <Button
                key={view.label}
                variant={pressed ? "primary" : "secondary"}
                size="sm"
                aria-pressed={pressed}
                onClick={() => go(withFilter(search, { show: view.value }))}
              >
                {view.label}
              </Button>
            );
          })}
        </fieldset>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<CopyIcon />}
          onClick={async () => {
            try {
              if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
                throw new Error("no clipboard");
              }
              await navigator.clipboard.writeText(listLink(origin, search));
              toast.success({ title: "Link copied" });
            } catch {
              toast.error({
                title: "Couldn’t copy the link",
                description: "Copy it from the address bar instead.",
              });
            }
          }}
        >
          Copy link
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu trigger={trigger("Staff member", actors.length)} className="w-72">
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
        <DropdownMenu trigger={trigger("Action", actions.length)} className="w-80">
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
        <DropdownMenu trigger={trigger("Date", datePreset === "any" ? 0 : 1)}>
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
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove filter: ${chip.label}`}
            className="inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-control bg-fill-selected px-3 text-label-sm text-text-secondary hover:text-text-primary focus-visible:outline-focus"
          >
            <span className="truncate">{chip.label}</span>
            <XIcon size={12} />
          </button>
        ))}
        {chips.length === 0 ? null : (
          <Button variant="ghost" size="sm" onClick={() => go(withoutFilters(search))}>
            Clear filters
          </Button>
        )}
      </div>
      {custom ? (
        <CustomDates open search={search} onClose={() => setCustom(false)} go={go} />
      ) : null}
    </div>
  );
}
