// Small parts the signed-out boards share, composed from @fin/ui and the tokens: the "or" rule, the
// quiet line under a title with its link, the loading card every signed-out route draws as its
// pending state, and a failure alert. Nothing here calls the API.
import { RouterLink } from "@fin/frame";
import { AuthCard, InlineAlert, Skeleton } from "@fin/ui";
import type { ReactNode } from "react";
import type { FailureAlert } from "../api/failures.ts";

export const TEXT_LINK =
  "rounded-xs text-label-sm text-text-primary underline decoration-border-strong underline-offset-4 hover:decoration-text-primary focus-visible:outline-focus";

export function OrRule() {
  return (
    <div className="flex items-center gap-3 text-caption text-text-tertiary" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** "New to Fin? Create an account": a sentence and a link. */
export function LeadLink(props: { text: string; href: string; children: ReactNode }) {
  return (
    <>
      {props.text}{" "}
      <RouterLink href={props.href} className={TEXT_LINK}>
        {props.children}
      </RouterLink>
    </>
  );
}

/** A quiet link under a form ("Use a different email"). */
export function QuietLink(props: { href: string; children: ReactNode }) {
  return (
    <RouterLink href={props.href} className={TEXT_LINK}>
      {props.children}
    </RouterLink>
  );
}

export function AlertFrom({ alert }: { alert: FailureAlert }) {
  return (
    <InlineAlert tone={alert.tone} title={alert.title} live={alert.live}>
      {alert.body}
    </InlineAlert>
  );
}

/** A signed-out board's `loading` state: the card's title and controls as shapes. */
export function AuthLoading() {
  return (
    <div data-slot="auth-card" className="w-full max-w-modal">
      <div
        aria-busy="true"
        className="flex flex-col gap-6 sm:rounded-md sm:border sm:border-transparent sm:bg-surface-raised sm:p-8 sm:shadow-ring"
      >
        <p role="status" className="sr-only">
          Loading
        </p>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="w-64 max-w-full" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton shape="block" className="h-12" />
          <Skeleton shape="block" className="h-12" />
        </div>
      </div>
    </div>
  );
}

/** A card whose content is a page-level failure or an end state. */
export function AuthMessage(props: { title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <AuthCard title={props.title} description={props.description}>
      {props.action ?? null}
    </AuthCard>
  );
}
