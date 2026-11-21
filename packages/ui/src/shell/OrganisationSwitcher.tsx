// The header's organisation switcher (spec 06 §4.3; UR-03, UR-05): a ghost button with the
// organisation's name and CaretUpDown, named "Switch organisation, current: {name}". Its menu, 240px
// wide, has a radio row per organisation with the person's role as a caption, then "Create
// organisation" and "Organisation settings". Choosing another runs `onSwitch` with the row pending;
// a failure is said inside the menu, which stays open ("The organisation didn't change." "Try
// again."). The server is the check; this only asks.
import { Menu, MenuRadioGroup, MenuTrigger } from "@ui-sdk/react/menu";
import { useState } from "react";
import { Glyph } from "./Glyph.tsx";
import { MenuPopup, MenuRadioRow, MenuRow, MenuRule } from "./parts.tsx";
import type { ShellLink } from "./Sidebar.tsx";

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
      },
    );
  };

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFailed(false);
      }}
    >
      <MenuTrigger
        aria-label={`Switch organisation, current: ${name}`}
        data-organisation-switcher=""
        className="inline-flex h-8 min-w-0 max-w-60 shrink items-center gap-1.5 rounded-control px-2.5 text-label text-text-primary outline-none transition-colors duration-fast hover:bg-fill-hover focus-visible:outline-focus state-open:bg-fill-hover"
      >
        <span className="truncate">{name}</span>
        <Glyph name="CaretUpDown" className="text-text-tertiary" />
      </MenuTrigger>
      <MenuPopup className="w-60">
        {organisations.length > 0 ? (
          <MenuRadioGroup
            value={currentId}
            onValueChange={(value, details) => {
              details.cancel();
              choose(value);
            }}
          >
            {organisations.map((organisation) => (
              <MenuRadioRow
                key={organisation.id}
                value={organisation.id}
                glyph="Buildings"
                caption={organisation.roleLabel}
                {...(pendingId === organisation.id
                  ? { "data-pending": "", "aria-busy": true }
                  : {})}
              >
                {organisation.name}
              </MenuRadioRow>
            ))}
          </MenuRadioGroup>
        ) : null}
        {failed ? (
          <p role="alert" className="px-2 py-1.5 text-caption text-status-danger-fg">
            The organisation didn’t change. Try again.
          </p>
        ) : null}
        {organisations.length > 0 ? <MenuRule /> : null}
        <MenuRow glyph="Plus" render={<Link href={createHref} />}>
          Create organisation
        </MenuRow>
        <MenuRow glyph="GearSix" render={<Link href={settingsHref} />}>
          Organisation settings
        </MenuRow>
      </MenuPopup>
    </Menu>
  );
}
