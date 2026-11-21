// Artwork as element data: rendered with createElement, never from markup strings parsed as HTML
// (the page policy and the lint rules refuse both).
import { createElement, type ReactNode } from "react";

export type SvgNode = {
  readonly t: string;
  readonly a: Readonly<Record<string, string>>;
  readonly c: readonly SvgNode[];
};

const PLACEHOLDER = /\{([A-Za-z0-9_-]+)\}/g;

/** Replaces each `{id}` placeholder with an id unique to this instance. */
export function withIds(value: string, prefix: string): string {
  return value.replace(PLACEHOLDER, (_m, id: string) => `${prefix}-${id}`);
}

/** Renders element data, giving its ids (and the url(#...) references to them) `prefix`. */
export function renderNodes(nodes: readonly SvgNode[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const props: Record<string, string | number> = { key: index };
    for (const [name, value] of Object.entries(node.a)) props[name] = withIds(value, prefix);
    return createElement(node.t, props, ...renderNodes(node.c, prefix));
  });
}
