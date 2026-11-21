// The route states every page uses for its error, not-found and not-allowed outcomes (spec 06 §2.5,
// §11.6 item 1), drawn inside the route's frame with the AppFrame and AdminFrame boards' copy, and
// the default pending state. A lane's route gives its own `-skeleton.tsx` as its pendingComponent;
// RoutePending is only the router's default.
import { PageHeading, PageProblem, PageSkeleton } from "@fin/ui/shell";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { isApiError } from "../api/errors.ts";
import { useAnyRouter } from "../router/matches.ts";
import { RouterLink } from "../router/RouterLink.tsx";

const HOME = { label: "Go to Home", glyph: "House", href: "/" } as const;

export function RoutePending() {
  return <PageSkeleton label="Loading" />;
}

export function RouteNotFound() {
  return (
    <PageHeading
      title="Page not found"
      description="The address may be wrong, or the page may have moved."
      primary={HOME}
      linkAs={RouterLink}
    />
  );
}

export function RouteNotAllowed() {
  return (
    <PageProblem
      glyph="LockSimple"
      title="You can’t open this page"
      description="Your role doesn’t allow this. Ask someone who can change roles."
      linkAs={RouterLink}
    />
  );
}

/** True when the browser says it is offline: the failure is the connection, not Fin. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useAnyRouter();
  const offline = isOffline();
  return (
    <PageProblem
      glyph="WarningCircle"
      tone="danger"
      title="Couldn’t load this page"
      description={
        offline
          ? "You’re offline. Check your connection and try again."
          : "The problem is on Fin’s side. Try again in a moment."
      }
      requestId={isApiError(error) ? error.requestId : null}
      actions={[
        {
          label: "Try again",
          glyph: "ArrowClockwise",
          onPress: () => {
            reset();
            void router.invalidate();
          },
        },
        { label: HOME.label, href: HOME.href },
      ]}
      linkAs={RouterLink}
    />
  );
}
