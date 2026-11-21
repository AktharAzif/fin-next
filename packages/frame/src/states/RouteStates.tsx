// The route states every page uses for its error, not-found and not-allowed outcomes (spec 06 §2.5,
// §11.6 item 1), drawn inside the route's frame with the AppFrame and AdminFrame boards' copy, and
// the default pending state. A lane's route gives its own `-skeleton.tsx` as its pendingComponent;
// RoutePending is only the router's default.
import { HouseIcon } from "@fin/icons";
import { buttonClasses, EmptyState, ErrorState, PageHeader, Skeleton } from "@fin/ui";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { isApiError } from "../api/errors.ts";
import { useAnyRouter } from "../router/matches.ts";
import { RouterLink } from "../router/RouterLink.tsx";

/** The frame's loading shapes before a page's first answer: never a spinner (spec 06 §5.2). */
export function RoutePending() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 pt-1">
      <p role="status" className="sr-only">
        Loading
      </p>
      <Skeleton shape="text" className="h-6 w-48" />
      <Skeleton shape="text" className="h-2 w-80 max-w-full" />
    </div>
  );
}

export function RouteNotFound() {
  return (
    <PageHeader
      title="Page not found"
      description="The address may be wrong, or the page may have moved."
      primaryAction={
        <RouterLink href="/" className={buttonClasses("primary", "sm")}>
          <HouseIcon />
          Go to Home
        </RouterLink>
      }
      linkAs={RouterLink}
    />
  );
}

export function RouteNotAllowed() {
  return (
    <EmptyState
      variant="no-permission"
      title="You can’t open this page"
      description="Your role doesn’t allow this. Ask someone who can change roles."
    />
  );
}

/** True when the browser says it is offline: the failure is the connection, not Fin. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useAnyRouter();
  const requestId = isApiError(error) ? error.requestId : null;
  return (
    <ErrorState
      size="page"
      title="Couldn’t load this page"
      description={
        isOffline()
          ? "You’re offline. Check your connection and try again."
          : "The problem is on Fin’s side. Try again in a moment."
      }
      onRetry={() => {
        reset();
        return router.invalidate();
      }}
      {...(requestId === null ? {} : { requestId })}
      action={
        <RouterLink href="/" className={buttonClasses("secondary", "md")}>
          Go to Home
        </RouterLink>
      }
    />
  );
}
