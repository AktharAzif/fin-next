// What a role cannot open is hidden, and what it cannot do is disabled with the reason (spec 02
// §8.7, [SA-16]). These only mirror the server's checks for the screens; the server refuses either
// way.

/** The reason a control a role cannot use carries, as its description and tooltip. */
export const NOT_ALLOWED_REASON = "Your role doesn't allow this. Ask someone who can change roles.";

/** What opening a page or using a control needs: every one of `allOf`, and one of `anyOf`. */
export interface Requirement<P extends string> {
  readonly allOf?: readonly P[];
  readonly anyOf?: readonly P[];
}

/**
 * Whether the held set meets the requirement. No requirement means always (the dashboard's Home
 * and Settings). An empty `anyOf` is met by nothing, so a half-written requirement fails closed.
 */
export function allows<P extends string>(
  held: ReadonlySet<P>,
  requirement: Requirement<NoInfer<P>> | undefined,
): boolean {
  if (requirement === undefined) return true;
  const { allOf, anyOf } = requirement;
  if (allOf !== undefined && !allOf.every((key) => held.has(key))) return false;
  if (anyOf !== undefined && !anyOf.some((key) => held.has(key))) return false;
  return true;
}

/** Something a navigation tree or a page lists, shown only when its requirement is met. */
export interface Guarded<P extends string> {
  readonly requires?: Requirement<P>;
}

/** The items the held set may open, in their order; the rest are left out. */
export function visibleItems<P extends string, T extends Guarded<NoInfer<P>>>(
  held: ReadonlySet<P>,
  items: readonly T[],
): T[] {
  return items.filter((item) => allows(held, item.requires));
}

/** A group of a navigation tree, with its visible items only. */
export type VisibleGroup<G extends { readonly items: readonly unknown[] }> = Omit<G, "items"> & {
  readonly items: G["items"][number][];
};

/** The groups with their visible items; a group left with none goes with them. */
export function visibleGroups<
  P extends string,
  G extends { readonly items: readonly Guarded<NoInfer<P>>[] },
>(held: ReadonlySet<P>, groups: readonly G[]): VisibleGroup<G>[] {
  const out: VisibleGroup<G>[] = [];
  for (const group of groups) {
    const items: G["items"][number][] = visibleItems(held, group.items);
    if (items.length > 0) out.push({ ...group, items });
  }
  return out;
}

/** `null` when the control may be used; otherwise the reason it is drawn disabled. */
export function disabledReason<P extends string>(
  held: ReadonlySet<P>,
  requirement: Requirement<NoInfer<P>> | undefined,
): string | null {
  return allows(held, requirement) ? null : NOT_ALLOWED_REASON;
}
