// Fin Admin's shared list layout (spec 06 §7.2, S6-33; INVENTORY §4.6): the filter bar's active
// filters as removable chips, and "Clear filters" once any is set. The list builds the chips (it
// knows what each filter says); a chip removes its whole filter.
//
// @pendingDesign UR-23: FilterChips is not in @fin/ui yet; composed here from its Button and
// tokens, it swaps for the kit's when it has one.
import { XIcon } from "@fin/icons";
import { Button, type EmptyStateFilter } from "@fin/ui";

/** One active filter: what it says, and how it is removed (the shape EmptyState's chips take). */
export type FilterChip = EmptyStateFilter;

export function FilterChips({
  chips,
  onClear,
}: {
  chips: readonly FilterChip[];
  /** Clears every filter (a list's view, when it has one, stays). */
  onClear: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <>
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
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear filters
      </Button>
    </>
  );
}
