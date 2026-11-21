// The header's organisation switcher (spec 06 §4.3; UR-03, UR-05): a ghost button with the
// organisation's name and CaretUpDown, named "Switch organisation, current: {name}". Its menu, 240px
// wide, has a radio row per organisation with the person's role as a caption, then "Create
// organisation" and "Organisation settings". Choosing another runs `onSwitch` with the menu marked
// pending; a failure is said inside the menu, which stays open ("The organisation didn't change."
// "Try again."). The server is the check; this only asks.
import { BuildingsIcon, CaretUpDownIcon, GearSixIcon, PlusIcon } from "@fin/icons";
import { useState } from "react";
import {
  DropdownMenu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../data/dropdown-menu.tsx";
import { Button } from "../foundation/button.tsx";
import { announce } from "../lib/announce.ts";
import type { ShellLink } from "./Sidebar.tsx";

const FAILED = "The organisation didn’t change. Try again.";

export interface OrganisationOption {
  readonly id: string;
  readonly name: string;
  /** The person's role in it, as the caption under its name. */
  readonly roleLabel: string;
}

export interface OrganisationSwitcherProps {
  organisations: readonly OrganisationOption[];
  currentId: string | null;
  /** Switches the current organisation; rejects when it did not change. */
  onSwitch: (organisationId: string) => Promise<void>;
  linkAs: ShellLink;
  createHref: string;
  settingsHref: string;
  /** Documentation and the kit only: draw the menu open. */
  defaultOpen?: boolean;
}

export function OrganisationSwitcher({
  organisations,
  currentId,
  onSwitch,
  linkAs: Link,
  createHref,
  settingsHref,
  defaultOpen = false,
}: OrganisationSwitcherProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const current = organisations.find((organisation) => organisation.id === currentId) ?? null;
  const name = current?.name ?? "No organisation";

  const choose = (organisationId: string) => {
    if (organisationId === currentId || pendingId !== null) return;
    setPendingId(organisationId);
    setFailed(false);
    onSwitch(organisationId).then(
      () => {
        setPendingId(null);
        setOpen(false);
      },
      () => {
        setPendingId(null);
        setFailed(true);
        // Spoken through the one assertive region (spec 06 §9), not a live region of its own.
        announce(FAILED, "assertive");
      },
    );
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFailed(false);
      }}
      className="w-60"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          trailingIcon={<CaretUpDownIcon className="text-text-tertiary" />}
          aria-label={`Switch organisation, current: ${name}`}
          data-organisation-switcher=""
          className="min-w-0 max-w-60 shrink"
        >
          <span className="truncate">{name}</span>
        </Button>
      }
    >
      {organisations.length > 0 ? (
        <MenuRadioGroup
          value={currentId}
          onValueChange={(value, details) => {
            // The row is checked only once the switch has worked: the viewer says so.
            details.cancel();
            choose(value);
          }}
          {...(pendingId === null ? {} : { "data-pending": "", "aria-busy": true })}
        >
          {organisations.map((organisation) => (
            <MenuRadioItem
              key={organisation.id}
              value={organisation.id}
              icon={<BuildingsIcon />}
              caption={pendingId === organisation.id ? "Switching…" : organisation.roleLabel}
              closeOnSelect={false}
            >
              {organisation.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      ) : null}
      {failed ? (
        <p className="m-0 px-2 py-1.5 text-caption text-status-danger-fg">{FAILED}</p>
      ) : null}
      {organisations.length > 0 ? <MenuSeparator /> : null}
      <MenuItem icon={<PlusIcon />} render={<Link href={createHref} />}>
        Create organisation
      </MenuItem>
      <MenuItem icon={<GearSixIcon />} render={<Link href={settingsHref} />}>
        Organisation settings
      </MenuItem>
    </DropdownMenu>
  );
}
