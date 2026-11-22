// Fin Admin's shared list layout (spec 06 §7.2, S6-33): a Date filter's "Custom…", a first and a
// last UTC day, either optional and both included. It checks the days before it hands them back.
//
// @pendingDesign UR-23: DateRangePicker is not in @fin/ui yet; composed here from its Modal, Field
// and Input, it swaps for the kit's when it has one.
import { Button, Field, Input, Modal } from "@fin/ui";
import { useState } from "react";

/** Custom days, `YYYY-MM-DD` in UTC; an absent day leaves that side open. */
export interface DayRange {
  from?: string | undefined;
  to?: string | undefined;
}

export function DateRangeDialog({
  open,
  initial,
  onClose,
  onApply,
}: {
  open: boolean;
  initial: DayRange;
  onClose: () => void;
  onApply: (range: DayRange) => void;
}) {
  const [from, setFrom] = useState(initial.from ?? "");
  const [to, setTo] = useState(initial.to ?? "");
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
              onApply({ from: from === "" ? undefined : from, to: to === "" ? undefined : to });
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
