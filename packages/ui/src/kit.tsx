// @fin/ui's kit-only exports (spec 06 §3.1, §10.3): things the kit renders and no screen may.
// Imported only by the kit (packages/ui/kit and, later, @fin/frame's src/kit/); never re-exported
// from index.ts.
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";

/**
 * The page-policy probes AC-P0-16 reads: a plain SDK popover (the SDK's reset must leave it with
 * no border, padding or fill), one styled with utilities (a layered utility must beat the reset),
 * and a hidden [data-slot] element with a display class (it must stay hidden).
 */
export function PolicyProbes() {
  return (
    <div className="flex flex-col gap-3">
      <Popover>
        <PopoverTrigger className="w-fit">Plain popover</PopoverTrigger>
        <PopoverContent data-kit="plain-popover" aria-label="Plain popover">
          Plain
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger className="w-fit">Styled popover</PopoverTrigger>
        <PopoverContent
          data-kit="styled-popover"
          aria-label="Styled popover"
          className="border border-border bg-surface-raised p-4"
        >
          Styled
        </PopoverContent>
      </Popover>
      <div data-kit="hidden-slot" data-slot="kit-probe" hidden className="flex">
        Hidden under a display class
      </div>
    </div>
  );
}
