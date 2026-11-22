// Turns a navigation tree into what this viewer sees (spec 06 §4.2): items left out when a
// permission is missing, when the route does not exist yet, or when the item is Sandbox-only in
// Production; empty groups dropped; the docs item pointed at the docs origin.
import type { NavContext, NavGroup, NavItem, NavItemDef, NavTree, NavTreeDef } from "./types.ts";

function resolveItem(item: NavItemDef, context: NavContext): NavItem | null {
  if (item.needs !== undefined && !item.needs.every((permission) => context.can(permission)))
    return null;
  if (item.sandboxOnly === true && context.environment !== "sandbox") return null;
  if (item.external === "docs") {
    if (context.docsOrigin === undefined) return null;
    return {
      id: item.id,
      label: item.label,
      href: new URL(item.path, context.docsOrigin).href,
      glyph: item.glyph,
      external: true,
    };
  }
  if (!context.hasRoute(item.path)) return null;
  return { id: item.id, label: item.label, href: item.path, glyph: item.glyph, external: false };
}

function resolveItems(items: readonly NavItemDef[], context: NavContext): NavItem[] {
  return items.flatMap((item) => {
    const resolved = resolveItem(item, context);
    return resolved === null ? [] : [resolved];
  });
}

export function filterNav(tree: NavTreeDef, context: NavContext): NavTree {
  const groups: NavGroup[] = tree.groups.flatMap((group) => {
    const items = resolveItems(group.items, context);
    if (items.length === 0) return [];
    return [
      group.label === undefined
        ? { id: group.id, items }
        : { id: group.id, label: group.label, items },
    ];
  });
  return { groups, footer: resolveItems(tree.footer, context) };
}

/** Every item of a tree, groups first, then the footer (for tests and checks). */
export function allNavItems(tree: NavTreeDef): NavItemDef[] {
  return [...tree.groups.flatMap((group) => group.items), ...tree.footer];
}
