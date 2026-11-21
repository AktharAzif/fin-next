// The signed-out frame (spec 06 §4.3; the sign-in family's boards): the Fin.com lockup at the top
// left, linking nowhere, and one centred card carrying `.fin-enter`. Verify's hosted pages use the
// same layout. The pages put their own heading, fields and actions in the card.
import type { ReactNode } from "react";
import { FinLockup } from "./brand.tsx";

export interface AuthLayoutProps {
  children: ReactNode;
  /** Under the card: a quiet line of links or a note. */
  footer?: ReactNode;
}

export function AuthLayout({ children, footer }: AuthLayoutProps) {
  return (
    <div data-auth-layout="" className="flex min-h-dvh flex-col bg-bg text-body text-text-primary">
      <div className="flex h-header shrink-0 items-center px-4 sm:px-8">
        <span role="img" aria-label="Fin.com" className="flex">
          <FinLockup height={20} />
        </span>
      </div>
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col items-center justify-center px-4 pt-6 pb-16 outline-none"
      >
        <div className="fin-enter w-full max-w-modal rounded-md border border-transparent bg-surface-raised p-6 shadow-ring sm:p-8">
          {children}
        </div>
        {footer === undefined ? null : (
          <div className="mt-6 text-caption text-text-tertiary">{footer}</div>
        )}
      </main>
    </div>
  );
}
