// Fin Admin's shared list layout (spec 06 §7.2, S6-33): a list's quick views ("All" and the views
// beside it) as pressed buttons in one group. The chosen view lives in the URL, so Back undoes it.
//
// @pendingDesign UR-23: part of TableToolbar, which is not in @fin/ui yet; composed from its
// Button until the kit has it.
import { Button } from "@fin/ui";

export interface QuickView<V extends string> {
  /** The view's value in the URL; undefined for "All". */
  value: V | undefined;
  label: string;
}

export function QuickViews<V extends string>({
  views,
  value,
  onChoose,
}: {
  views: readonly QuickView<V>[];
  value: V | undefined;
  onChoose: (value: V | undefined) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Views</legend>
      {views.map((view) => {
        const pressed = value === view.value;
        return (
          <Button
            key={view.label}
            variant={pressed ? "primary" : "secondary"}
            size="sm"
            aria-pressed={pressed}
            onClick={() => onChoose(view.value)}
          >
            {view.label}
          </Button>
        );
      })}
    </fieldset>
  );
}
