// Fin Admin's shared list layout (spec 06 §7.2, S6-33): the pieces of a filter's menu on @fin/ui's
// DropdownMenu. Each choice toggles one value and closes the menu; the trigger says how many
// values the filter holds.
//
// @pendingDesign UR-23: FilterMenu is not in @fin/ui yet; composed here from its Button and
// DropdownMenu, it swaps for the kit's when it has one.
import { CaretDownIcon, CheckIcon } from "@fin/icons";
import { Button } from "@fin/ui";

/**
 * A filter's trigger: its name, and how many values it holds. The Button element itself, never a
 * component around it: the menu gives its trigger the props that open it.
 */
export function filterTrigger(label: string, count: number) {
  return (
    <Button variant="secondary" size="sm" trailingIcon={<CaretDownIcon />}>
      {count === 0 ? label : `${label} (${count})`}
    </Button>
  );
}

/** A choice's mark: a check when it is chosen, else the space a check takes, so labels align. */
export function Picked({ on }: { on: boolean }) {
  return on ? <CheckIcon /> : <span aria-hidden="true" className="inline-block size-4" />;
}
