// Fin Admin's shared list layout (spec 06 §7.2, S6-33; INVENTORY §4.6): the side drawer a list's
// row opens, with no full page behind it, and its "‹ 4 of 50 ›" stepper through the rows on the
// page. A record opened from a link to a row not on the page has no stepper.
//
// @pendingDesign UR-24: the Drawer (S) of @fin/ui; until the kit has it, the board's side sheet is
// @fin/ui's Modal drawn at the drawer's width on the right (full width on phones).
import { CaretLeftIcon, CaretRightIcon } from "@fin/icons";
import { IconButton, Modal } from "@fin/ui";
import type { ReactNode } from "react";

/** The side sheet: the drawer's S width, full height, on the right; full width on phones. */
const SHEET = "inset-x-auto right-0 m-0 h-full max-h-full w-full max-w-drawer-s rounded-none gap-6";

/** Where the open row sits on the page; a side with nothing that way has no move. */
export interface DrawerStep {
  /** The open row's place on the page, from 0. */
  index: number;
  /** How many rows the page holds. */
  count: number;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}

/** "‹ 4 of 50 ›": Previous and Next through the page's rows, each saying why when it is off. */
export function DrawerStepper({ step, noun }: { step: DrawerStep; noun: string }) {
  return (
    <div className="flex items-center gap-1">
      <IconButton
        label={`Previous ${noun}`}
        size="sm"
        icon={<CaretLeftIcon />}
        {...(step.onPrevious === undefined
          ? { disabledReason: `This is the first ${noun} on this page.` }
          : {})}
        onClick={() => step.onPrevious?.()}
      />
      <span className="text-caption text-text-tertiary tabular-nums">
        {`${step.index + 1} of ${step.count}`}
      </span>
      <IconButton
        label={`Next ${noun}`}
        size="sm"
        icon={<CaretRightIcon />}
        {...(step.onNext === undefined
          ? { disabledReason: `This is the last ${noun} on this page.` }
          : {})}
        onClick={() => step.onNext?.()}
      />
    </div>
  );
}

export function SideDrawer({
  title,
  description,
  noun,
  step,
  onClose,
  children,
}: {
  title: string;
  description: string;
  /** What one row is called ("staff action"), for the stepper's names. */
  noun: string;
  /** The stepper; absent for a record that is not on the page. */
  step?: DrawerStep | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description={description}
      className={SHEET}
    >
      {step === undefined ? null : <DrawerStepper step={step} noun={noun} />}
      {children}
    </Modal>
  );
}
