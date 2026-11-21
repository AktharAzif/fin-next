// The router's link for @fin/ui's router-free components (`linkAs`, or the UI SDK's `render`):
// a real <a href> that the router takes over for a plain left click on one of the app's own paths,
// and preloads on intent (FW-C10). Another origin, a new tab, a download, a modified click or a
// path under /api stays a browser navigation. Props, handlers and the ref pass through, as the
// SDK's `render` expects.

import type { AnchorHTMLAttributes, MouseEvent, Ref } from "react";
import { useAnyRouter } from "./matches.ts";

export interface RouterLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  /** Replace the history entry instead of pushing one. */
  replace?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}

/** True for a path on this app that the router may handle (never /api, never another origin). */
export function isRouterHref(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  const path = href.split(/[?#]/, 1)[0] ?? "";
  return path !== "/api" && !path.startsWith("/api/");
}

export function RouterLink({
  href,
  replace,
  onClick,
  onMouseEnter,
  onFocus,
  ref,
  ...rest
}: RouterLinkProps) {
  const router = useAnyRouter();
  const routed =
    isRouterHref(href) &&
    (rest.target === undefined || rest.target === "_self") &&
    rest.download === undefined;

  const preload = () => {
    if (!routed) return;
    // The router builds a location from `href` as navigate() does (router-core's buildLocation); the
    // preload options' type asks for `to` only because it is typed for a registered route tree.
    router
      .preloadRoute({ href } as unknown as Parameters<typeof router.preloadRoute>[0])
      .catch(() => {
        // A failed preload is retried by the navigation itself, which shows its own error state.
      });
  };

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !routed) return;
    if (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)
      return;
    event.preventDefault();
    void router.navigate(replace === true ? { href, replace: true } : { href });
  };

  return (
    <a
      {...rest}
      ref={ref}
      href={href}
      onClick={handleClick}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        preload();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        preload();
      }}
    />
  );
}
