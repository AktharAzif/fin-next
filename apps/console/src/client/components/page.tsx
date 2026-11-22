// What the signed-in boards share: the viewer and its permissions, the two-column settings
// section (a title and its action on the left, the content on the right), Settings' tabs, a
// section's loading and failure, and the reason a control is disabled ([SA-16]: what a role cannot
// do is drawn disabled with the reason; the server refuses regardless).
import { NOT_ALLOWED_REASON } from "@fin/access";
import type { ConsoleViewer, ConsoleViewerSignedIn } from "@fin/app-contracts";
import { RouterLink, useFin, useStore } from "@fin/frame";
import { ErrorState, Skeleton, SkeletonText, TabLink, TabLinks } from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { failureOf, requestIdOf } from "../api/failures.ts";

/** The reason a control the role cannot use is disabled (spec 02 §8.7). */
export const ROLE_REASON = NOT_ALLOWED_REASON;

export interface SignedIn {
  viewer: ConsoleViewerSignedIn;
  can: (permission: string) => boolean;
  /** The current organisation's membership, or null. */
  membership: ConsoleViewerSignedIn["memberships"][number] | null;
}

/** The signed-in viewer on an `app` page (AppFrame draws only once there is one). */
export function useSignedIn(): SignedIn | null {
  const fin = useFin<ConsoleViewer>();
  const viewer = useStore(fin.viewer);
  if (viewer === null || viewer.gate === "factor_step") return null;
  const permissions = new Set(viewer.permissions);
  return {
    viewer,
    can: (permission) => permissions.has(permission),
    membership: viewer.memberships.find((m) => m.orgId === viewer.currentOrgId) ?? null,
  };
}

export function SettingsSection(props: {
  title: string;
  description?: ReactNode;
  /** The section's action, under its title. */
  action?: ReactNode;
  /** A count beside the title (members, invitations). */
  count?: number;
  /** A quiet link at the title row's end ("See changes in the audit log"). */
  aside?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  const headingId = `${props.id ?? props.title.toLowerCase().replace(/[^a-z]+/g, "-")}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-6 border-t border-border pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10"
    >
      <div className="flex flex-col items-start gap-3">
        <div className="flex w-full items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2
              id={headingId}
              className="m-0 flex items-baseline gap-2 text-heading text-text-primary"
            >
              {props.title}
              {props.count === undefined ? null : (
                <span className="text-label text-text-tertiary">{props.count}</span>
              )}
            </h2>
            {props.description === undefined ? null : (
              <p className="m-0 text-body text-text-secondary">{props.description}</p>
            )}
          </div>
          {props.aside}
        </div>
        {props.action}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{props.children}</div>
    </section>
  );
}

/** A full-width block with a heading row (Team's members and invitations, Roles' lists). */
export function Block(props: {
  title: string;
  count?: number;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${props.title.toLowerCase().replace(/[^a-z]+/g, "-")}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2
            id={headingId}
            className="m-0 flex items-baseline gap-2 text-heading text-text-primary"
          >
            {props.title}
            {props.count === undefined ? null : (
              <span className="text-label text-text-tertiary">{props.count}</span>
            )}
          </h2>
          {props.description === undefined ? null : (
            <p className="m-0 text-body text-text-secondary">{props.description}</p>
          )}
        </div>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

/** A quiet link with an arrow ("See changes in the audit log"). */
export function QuietArrowLink(props: { href: string; children: ReactNode }) {
  return (
    <RouterLink
      href={props.href}
      className="inline-flex items-center gap-1 rounded-xs text-label-sm text-text-secondary no-underline hover:text-text-primary focus-visible:outline-focus"
    >
      {props.children}
      <span aria-hidden="true">→</span>
    </RouterLink>
  );
}

/** Settings' tabs (round 2): Organisation · Go to Production · Team · Roles, each once it exists. */
export function SettingsTabs(props: { current: "organisation" | "team" | "roles" }) {
  const router = useRouter();
  const signedIn = useSignedIn();
  const exists = (path: string) => router.getMatchedRoutes(path)[2] !== undefined;
  const canRead = signedIn?.can("member.read") === true;
  const tabs: { id: string; label: string; href: string; shown: boolean }[] = [
    { id: "organisation", label: "Organisation", href: "/settings/organisation", shown: true },
    {
      id: "production",
      label: "Go to Production",
      href: "/settings/go-live",
      shown: exists("/settings/go-live"),
    },
    { id: "team", label: "Team", href: "/settings/team", shown: canRead },
    { id: "roles", label: "Roles", href: "/settings/roles", shown: canRead },
  ];
  return (
    <TabLinks label="Settings" linkAs={RouterLink}>
      {tabs
        .filter((tab) => tab.shown)
        .map((tab) => (
          <TabLink key={tab.id} href={tab.href} current={tab.id === props.current}>
            {tab.label}
          </TabLink>
        ))}
    </TabLinks>
  );
}

/** A section's failure: "Couldn't load {things}", with Try again and the request ID. */
export function SectionFailure(props: {
  title: string;
  error: unknown;
  onRetry: () => unknown;
  size?: "section" | "page";
}) {
  const requestId = requestIdOf(props.error);
  return (
    <ErrorState
      size={props.size ?? "section"}
      {...(props.size === "page" ? { headingLevel: 2 as const } : {})}
      title={props.title}
      description={
        failureOf(props.error) === "offline"
          ? "You’re offline. Check your connection and try again."
          : "Something went wrong on our side. Try again in a moment."
      }
      onRetry={props.onRetry}
      {...(requestId === undefined ? {} : { requestId })}
    />
  );
}

/** A form section's loading shapes: a label, a control, a line. */
export function FieldsLoading(props: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        Loading {props.label}
      </p>
      <Skeleton className="w-24" />
      <Skeleton shape="control" className="w-full" />
      <SkeletonText lines={1} className="w-60" />
    </div>
  );
}
