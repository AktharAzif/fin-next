// A choice drawn as a card (ProtectAccount's "Add a passkey" and "Use an authenticator app"): an
// icon tile, a title with an optional badge, a line under it, and a caret. @fin/ui has no option
// card yet, so it is composed here from the design system's tokens and its Spinner and Badge, and
// marked pending (UI-03).
// @pendingDesign UR-21: an option card in @fin/ui (ProtectAccount).
import { RouterLink } from "@fin/frame";
import { CaretRightIcon } from "@fin/icons";
import { Badge, Spinner } from "@fin/ui";
import type { ReactNode } from "react";

const CARD =
  "flex w-full cursor-pointer items-center gap-4 rounded-md border border-border bg-surface-raised p-4 text-left no-underline transition-field hover:border-border-strong hover:bg-fill-hover focus-visible:outline-focus disabled:cursor-progress disabled:opacity-70";

interface OptionCardBody {
  icon: ReactNode;
  title: string;
  badge?: string;
  children: ReactNode;
  busy?: boolean;
}

function Body(props: OptionCardBody) {
  return (
    <>
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface-raised text-text-secondary"
      >
        {props.busy === true ? <Spinner /> : props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-label text-text-primary">
          {props.title}
          {props.badge === undefined ? null : (
            <Badge variant="secondary" size="sm">
              {props.badge}
            </Badge>
          )}
        </span>
        <span className="text-body text-text-secondary">{props.children}</span>
      </span>
      <CaretRightIcon className="shrink-0 text-text-tertiary" />
    </>
  );
}

export function OptionButton(props: OptionCardBody & { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={CARD}
      onClick={props.onClick}
      disabled={props.disabled === true || props.busy === true}
      aria-busy={props.busy === true || undefined}
    >
      <Body {...props} />
    </button>
  );
}

export function OptionLink(props: OptionCardBody & { href: string }) {
  return (
    <RouterLink href={props.href} className={CARD}>
      <Body {...props} />
    </RouterLink>
  );
}
