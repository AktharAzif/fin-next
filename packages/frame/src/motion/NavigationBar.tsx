// The navigation progress bar (spec 06 §5.1, AppFrame `navigating`; UR-10): a 2px bar across the top
// of the content that grows from the left while a navigation's loaders run. When the navigation
// ends it stays mounted for one short fade (`fin-swap-out`, 140ms) and then goes. Hover preloads
// never change the router's status, so they never show it.
import { useEffect, useState } from "react";

export const NAVIGATION_BAR_FADE_MS = 140;

export interface NavigationBarProps {
  pending: boolean;
}

export function NavigationBar({ pending }: NavigationBarProps) {
  const [fading, setFading] = useState(false);
  const [wasPending, setWasPending] = useState(pending);

  if (pending !== wasPending) {
    // Derived during render (no effect round trip): a pending navigation that just ended fades out.
    setWasPending(pending);
    setFading(!pending);
  }

  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFading(false), NAVIGATION_BAR_FADE_MS);
    return () => clearTimeout(timer);
  }, [fading]);

  if (pending) {
    return (
      <div
        role="progressbar"
        aria-label="Loading"
        data-navigation-bar=""
        className="fin-progress pointer-events-none absolute inset-x-0 top-0 z-sticky h-0.5 bg-text-primary"
      />
    );
  }
  if (fading) {
    return (
      <div
        aria-hidden="true"
        data-navigation-bar=""
        className="fin-progress fin-swap-out pointer-events-none absolute inset-x-0 top-0 z-sticky h-0.5 bg-text-primary"
      />
    );
  }
  return null;
}
