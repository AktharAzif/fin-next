// The signed-in person's menu, at the header's far end (spec 06 §4.3; UR-07). The trigger shows
// initials, never a photo (the first letter of the email when there is no name), named "Account
// menu, {name or email}". The console's menu, 288px wide: the name (or "Your account"), the email and
// the role caption; Account security; Theme (Light, Dark, System), applied at once; Log out, which
// never asks. Fin Admin's staff menu: the email (staff have no names), "{role} · Cloudflare Access",
// Your sign-in, Log out, and no theme choice (Fin Admin follows the system).
import { Menu, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuTrigger } from "@ui-sdk/react/menu";
import { Glyph } from "./Glyph.tsx";
import { MenuIdentity, MenuPopup, MenuRadioRow, MenuRow, MenuRule } from "./parts.tsx";
import type { ShellLink } from "./Sidebar.tsx";

export type ShellThemeChoice = "light" | "dark" | "system";

function firstLetters(words: string[]): string {
  return words
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => (word[0] ?? "").toLocaleUpperCase("en-GB"))
    .join("");
}

/**
 * Up to two initials from the name; with no name, from the email's local part split at dots,
 * dashes and underscores ("maya@…" gives "M", the canvases' `noName`; "nadia.brooks@…" gives "NB",
 * as Fin Admin draws staff, who have no names).
 */
export function initials(name: string, email: string): string {
  const fromName = firstLetters(name.trim().split(/\s+/));
  if (fromName !== "") return fromName;
  const local = email.trim().split("@")[0] ?? "";
  return firstLetters(local.split(/[._-]+/)) || "?";
}

function Trigger({ label, initialsText }: { label: string; initialsText: string }) {
  return (
    <MenuTrigger
      aria-label={label}
      data-account-menu=""
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-control pr-1 pl-1 text-text-tertiary outline-none transition-colors duration-fast hover:bg-fill-hover hover:text-text-secondary focus-visible:outline-focus state-open:bg-fill-hover"
    >
      <span
        aria-hidden="true"
        className="inline-flex size-6 items-center justify-center rounded-full bg-surface-subtle text-caption font-medium text-text-primary"
      >
        {initialsText}
      </span>
      <Glyph name="CaretDown" />
    </MenuTrigger>
  );
}

export interface AccountMenuProps {
  name: string;
  email: string;
  /** The role in the current organisation, as the caption; null when there is none. */
  roleLabel: string | null;
  theme: ShellThemeChoice;
  onThemeChange: (theme: ShellThemeChoice) => void;
  /** Account security's path. */
  securityHref: string;
  linkAs: ShellLink;
  /** Posts sign-out; the item stays pending until it settles. */
  onLogOut: () => Promise<unknown>;
  /** Documentation and the kit only: draw the menu open. */
  defaultOpen?: boolean;
}

export function AccountMenu({
  name,
  email,
  roleLabel,
  theme,
  onThemeChange,
  securityHref,
  linkAs: Link,
  onLogOut,
  defaultOpen = false,
}: AccountMenuProps) {
  const who = name.trim() === "" ? email : name;
  return (
    <Menu defaultOpen={defaultOpen}>
      <Trigger label={`Account menu, ${who}`} initialsText={initials(name, email)} />
      <MenuPopup className="w-72" align="end">
        <MenuIdentity
          title={name.trim() === "" ? "Your account" : name}
          caption={roleLabel === null ? email : `${email} · ${roleLabel}`}
        />
        <MenuRule />
        <MenuRow glyph="ShieldCheck" render={<Link href={securityHref} />}>
          Account security
        </MenuRow>
        <MenuGroup>
          <MenuGroupLabel className="px-2 pt-2 pb-1 text-caption text-text-tertiary">
            Theme
          </MenuGroupLabel>
          <MenuRadioGroup
            value={theme}
            onValueChange={(value) => {
              if (value === "light" || value === "dark" || value === "system") onThemeChange(value);
            }}
          >
            <MenuRadioRow value="light" glyph="Sun">
              Light
            </MenuRadioRow>
            <MenuRadioRow value="dark" glyph="Moon">
              Dark
            </MenuRadioRow>
            <MenuRadioRow value="system" glyph="Desktop">
              System
            </MenuRadioRow>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuRule />
        <MenuRow glyph="SignOut" onSelect={() => onLogOut()}>
          Log out
        </MenuRow>
      </MenuPopup>
    </Menu>
  );
}

export interface StaffMenuProps {
  email: string;
  roleLabel: string;
  /** "Cloudflare Access" on staging and production; the development stand-in elsewhere. */
  signIn: "access" | "development";
  /** "Your sign-in" (AdminAccount). */
  accountHref: string;
  linkAs: ShellLink;
  onLogOut: () => Promise<unknown>;
  defaultOpen?: boolean;
}

export function StaffMenu({
  email,
  roleLabel,
  signIn,
  accountHref,
  linkAs: Link,
  onLogOut,
  defaultOpen = false,
}: StaffMenuProps) {
  return (
    <Menu defaultOpen={defaultOpen}>
      <Trigger label={`Account menu, ${email}`} initialsText={initials("", email)} />
      <MenuPopup className="w-72" align="end">
        <MenuIdentity
          title={email}
          caption={
            signIn === "access"
              ? `${roleLabel} · Cloudflare Access`
              : `${roleLabel} · Development sign-in`
          }
        />
        <MenuRule />
        <MenuRow glyph="UserCircle" render={<Link href={accountHref} />}>
          Your sign-in
        </MenuRow>
        <MenuRule />
        <MenuRow glyph="SignOut" onSelect={() => onLogOut()}>
          Log out
        </MenuRow>
      </MenuPopup>
    </Menu>
  );
}
