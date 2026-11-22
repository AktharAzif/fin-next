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

/**
 * The markup without its tags, read in one pass: a `<` with at least one character before the next
 * `>` opens a tag that ends there. A `<>`, and a `<` that no `>` follows, are text.
 */
function withoutTags(html: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<", at);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      out += html.slice(at, close);
      at = close;
      continue;
    }
    out += html.slice(at, open);
    at = close + 1;
  }
  return out + html.slice(at);
}

/** The text of the markup, without tags, with the two entities React writes in text decoded. */
export function text(html: string): string {
  // "&amp;" last, so an escaped entity ("&amp;#x27;") is decoded once, to "&#x27;".
  return withoutTags(html).replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
}
