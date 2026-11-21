// The signed-in person's menu, at the header's far end (spec 06 §4.3; UR-07). The trigger shows
// initials, never a photo (the first letter of the email when there is no name), named "Account
// menu, {name or email}". The console's menu, 288px wide: the name (or "Your account"), the email and
// the role caption; Account security; Theme (Light, Dark, System), applied at once; Log out, which
// never asks. Fin Admin's staff menu: the email (staff have no names), "{role} · Cloudflare Access",
// Your sign-in, Log out, and no theme choice (Fin Admin follows the system).
import {
  CaretDownIcon,
  DesktopIcon,
  MoonIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SunIcon,
  UserCircleIcon,
} from "@fin/icons";
import type { ComponentPropsWithRef } from "react";
import {
  DropdownMenu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../data/dropdown-menu.tsx";
import { Avatar } from "../foundation/avatar.tsx";
import { cn } from "../lib/cn.ts";
import type { ShellLink } from "./Sidebar.tsx";

export type ShellThemeChoice = "light" | "dark" | "system";

/**
 * The name the staff menu's initials come from: staff have no names, so the email's local part,
 * split at dots, dashes and underscores ("nadia.brooks@…" draws NB, as Fin Admin's boards do).
 */
export function nameFromEmail(email: string): string {
  return (email.split("@")[0] ?? "")
    .split(/[._-]+/)
    .filter(Boolean)
    .join(" ");
}

type TriggerProps = ComponentPropsWithRef<"button"> & {
  label: string;
  name: string;
  email: string;
};

/** The menu's trigger. The menu renders it with its own props and ref, so both are passed on. */
function Trigger({ label, name, email, className, ...props }: TriggerProps) {
  return (
    <button
      type="button"
      {...props}
      aria-label={label}
      data-account-menu=""
      className={cn(
        "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-control border-0 bg-transparent px-1 text-text-tertiary outline-none transition-colors duration-fast hover:bg-fill-hover hover:text-text-secondary focus-visible:outline-focus state-open:bg-fill-hover",
        className,
      )}
    >
      <Avatar name={name} email={email} size={24} />
      <CaretDownIcon className="hidden lg:block" />
    </button>
  );
}

/** Who is signed in, at the top of the menu: a static line, never an item. */
function Identity({ title, caption }: { title: string; caption: string }) {
  return (
    <div role="none" className="flex flex-col px-2 py-1.5">
      <span className="truncate text-label text-text-primary">{title}</span>
      <span className="truncate text-caption text-text-tertiary">{caption}</span>
    </div>
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
  const named = name.trim() !== "";
  return (
    <DropdownMenu
      align="end"
      defaultOpen={defaultOpen}
      className="w-72"
      trigger={
        <Trigger label={`Account menu, ${named ? name : email}`} name={name} email={email} />
      }
    >
      <Identity
        title={named ? name : "Your account"}
        caption={roleLabel === null ? email : `${email} · ${roleLabel}`}
      />
      <MenuSeparator />
      <MenuItem icon={<ShieldCheckIcon />} render={<Link href={securityHref} />}>
        Account security
      </MenuItem>
      <MenuRadioGroup
        label="Theme"
        value={theme}
        onValueChange={(value) => {
          if (value === "light" || value === "dark" || value === "system") onThemeChange(value);
        }}
      >
        <MenuRadioItem value="light" icon={<SunIcon />}>
          Light
        </MenuRadioItem>
        <MenuRadioItem value="dark" icon={<MoonIcon />}>
          Dark
        </MenuRadioItem>
        <MenuRadioItem value="system" icon={<DesktopIcon />}>
          System
        </MenuRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem icon={<SignOutIcon />} onSelect={() => onLogOut()}>
        Log out
      </MenuItem>
    </DropdownMenu>
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
    <DropdownMenu
      align="end"
      defaultOpen={defaultOpen}
      className="w-72"
      trigger={
        <Trigger label={`Account menu, ${email}`} name={nameFromEmail(email)} email={email} />
      }
    >
      <Identity
        title={email}
        caption={
          signIn === "access"
            ? `${roleLabel} · Cloudflare Access`
            : `${roleLabel} · Development sign-in`
        }
      />
      <MenuSeparator />
      <MenuItem icon={<UserCircleIcon />} render={<Link href={accountHref} />}>
        Your sign-in
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<SignOutIcon />} onSelect={() => onLogOut()}>
        Log out
      </MenuItem>
    </DropdownMenu>
  );
}
