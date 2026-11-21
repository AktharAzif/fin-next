// The navigation trees (spec 06 §4.2). Each area's lane owns its fragment in
// `src/nav/{console,admin}/<area>.ts`; `index.ts` assembles them in the order the canvases draw.
// Labels equal the page titles, word for word. An item the viewer's permissions cannot open is
// left out, an empty group goes with it ([SA-16]), and an item appears only once its route exists.
import type { GlyphName } from "@fin/icons";

export interface NavItemDef {
  /** The `staticData.navId` of the routes under this item. */
  readonly id: string;
  /** The page title, word for word. */
  readonly label: string;
  /** The item's route; for `external: "docs"`, the path on the docs site. */
  readonly path: string;
  readonly glyph: GlyphName;
  /** Every permission listed is needed (the server refuses regardless, [SA-16]). */
  readonly needs?: readonly string[];
  /** Shown in Sandbox only (the Simulator). */
  readonly sandboxOnly?: boolean;
  /** API docs: on the docs origin from env.json, opened in a new tab that says so. */
  readonly external?: "docs";
}

export interface NavGroupDef {
  readonly id: string;
  /** Left out for the first group. */
  readonly label?: string;
  readonly items: readonly NavItemDef[];
}

export interface NavTreeDef {
  readonly groups: readonly NavGroupDef[];
  /** Pinned to the bottom of the sidebar. */
  readonly footer: readonly NavItemDef[];
}

/** One item as the Sidebar draws it. */
export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly glyph: GlyphName;
  readonly external: boolean;
}

export interface NavGroup {
  readonly id: string;
  readonly label?: string;
  readonly items: readonly NavItem[];
}

export interface NavTree {
  readonly groups: readonly NavGroup[];
  readonly footer: readonly NavItem[];
}

export interface NavContext {
  /** Whether the viewer holds a permission in the current organisation (or as staff). */
  can(permission: string): boolean;
  /** Whether the app has a route at this path yet. */
  hasRoute(path: string): boolean;
  /** The console's environment; Fin Admin passes "production". */
  environment: "sandbox" | "production";
  /** env.json's docsOrigin, for the API docs item. */
  docsOrigin?: string;
}
