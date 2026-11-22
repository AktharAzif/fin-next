// Small readers over static markup, for the unit tests (no DOM package, G-06).
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export const render = (element: ReactElement): string => renderToStaticMarkup(element);

/** The opening tags of every element with `attribute` (and `value`, when given). */
export function tagsWith(html: string, attribute: string, value?: string): string[] {
  const pattern =
    value === undefined
      ? new RegExp(`<[a-z0-9]+\\b[^>]*\\s${attribute}(?:="[^"]*")?[^>]*>`, "g")
      : new RegExp(
          `<[a-z0-9]+\\b[^>]*\\s${attribute}="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
          "g",
        );
  return html.match(pattern) ?? [];
}

/** The value of `attribute` on an opening tag. */
export function attr(tag: string | undefined, attribute: string): string | undefined {
  if (tag === undefined) return undefined;
  return new RegExp(`\\s${attribute}="([^"]*)"`).exec(tag)?.[1];
}

/** The classes of an opening tag. */
export function classes(tag: string | undefined): string[] {
  return (attr(tag, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** The text of the markup, without tags. */
export function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}
