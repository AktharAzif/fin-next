// AuthLayout, AuthCard and AuthFooter (spec 06 §3.3, §4.3): the signed-out page and verify's hosted
// pages. On wide screens the Fin.com lockup sits 32px in from the top left and one 480px card,
// 32px padded, is centred; on phones there is no card, only the 18px F mark and 16px gutters. The
// card carries fin-enter, so it fades in, rising 4px, when it mounts.
import type { ElementType, ReactNode } from "react";
import { Logo } from "../foundation/logo.tsx";
import { cn } from "../lib/cn.ts";

export type AuthLayoutProps = {
  /** Where the logo links: "/" in the console. Set null on verify's pages, whose logo is no link. */
  homeHref?: string | null;
  /** The app's router link; a plain <a> by default. */
  linkAs?: ElementType<{
    href: string;
    className?: string;
    "aria-label"?: string;
    children?: ReactNode;
  }>;
  /** The developer's own name on verify's white-label pages, in place of Fin's logo. */
  brand?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
};

function Brand(props: Pick<AuthLayoutProps, "homeHref" | "linkAs" | "brand">) {
  if (props.brand !== undefined) return <>{props.brand}</>;
  const marks = (
    <>
      <Logo variant="full" height={18} className="hidden sm:block" />
      <Logo variant="mark" height={18} className="sm:hidden" />
    </>
  );
  if (props.homeHref === null) return marks;
  const Link = props.linkAs ?? "a";
  return (
    <Link
      href={props.homeHref ?? "/"}
      aria-label="Fin home"
      className="inline-flex rounded-control focus-visible:outline-focus"
    >
      {marks}
    </Link>
  );
}

export function AuthLayout(props: AuthLayoutProps) {
  return (
    <div
      data-slot="auth-layout"
      className={cn(
        "flex min-h-dvh flex-col gap-8 bg-bg p-4 text-text-primary sm:gap-0 sm:p-8",
        props.className,
      )}
    >
      <header className="flex h-6 items-center">
        <Brand {...props} />
      </header>
      <main
        id="main"
        className="flex flex-1 items-start justify-center sm:items-center sm:pt-8 sm:pb-14"
      >
        {props.children}
      </main>
      {props.footer === undefined ? null : props.footer}
    </div>
  );
}

/** The one card of a signed-out page: a title, a line under it, then the form. */
export function AuthCard(props: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="auth-card" className="fin-enter w-full max-w-modal">
      <section
        aria-labelledby="auth-card-title"
        className={cn(
          "flex flex-col gap-6 bg-bg sm:rounded-md sm:border sm:border-transparent sm:bg-surface-raised sm:p-8 sm:shadow-ring",
          props.className,
        )}
      >
        <div className="flex flex-col gap-1">
          <h1
            id="auth-card-title"
            tabIndex={-1}
            className="m-0 text-title text-text-primary outline-none"
          >
            {props.title}
          </h1>
          {props.description === undefined ? null : (
            <p className="m-0 text-body text-text-secondary">{props.description}</p>
          )}
        </div>
        {props.children}
      </section>
    </div>
  );
}

/** Quiet links under the card: terms, privacy, help. */
export function AuthFooter(props: { children: ReactNode; className?: string }) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center justify-center gap-4 text-caption text-text-tertiary",
        props.className,
      )}
    >
      {props.children}
    </footer>
  );
}
