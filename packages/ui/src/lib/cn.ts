// cn: Fin's in-house class merger (spec 06 §3.3; clsx and tailwind-merge are refused, OD-5).
// It joins class values and, where two classes set the same thing under the same variants, keeps
// the later one, so a caller's className overrides a component's default. It knows Fin's utility
// names (theme.css), not every Tailwind utility: an unknown class is kept as it is.

export type ClassValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | readonly ClassValue[]
  | { readonly [name: string]: unknown };

const TYPE_ROLES = new Set([
  "display",
  "amount-lg",
  "title",
  "heading",
  "body-lg",
  "body",
  "label",
  "label-sm",
  "caption",
  "mono",
]);
const TEXT_ALIGN = new Set(["left", "center", "right", "start", "end", "justify"]);
const DISPLAY = new Set([
  "block",
  "inline",
  "inline-block",
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "hidden",
  "contents",
  "table",
  "table-row",
  "table-cell",
  "list-item",
  "flow-root",
]);
const POSITION = new Set(["static", "fixed", "absolute", "relative", "sticky"]);

const PREFIX_GROUPS: [RegExp, string][] = [
  [/^(px|py|pt|pr|pb|pl|ps|pe|p)-/, "$1"],
  [/^(mx|my|mt|mr|mb|ml|ms|me|m)-/, "$1"],
  [/^(min-w|min-h|max-w|max-h|size|w|h)-/, "$1"],
  [/^(gap-x|gap-y|gap)-/, "$1"],
  [/^(inset-x|inset-y|inset|top|right|bottom|left|start|end)-/, "$1"],
  [/^(rounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?)(?:-|$)/, "$1"],
  [/^shadow(?:-|$)/, "shadow"],
  [/^bg-/, "bg"],
  [/^z-/, "z"],
  [/^opacity-/, "opacity"],
  [/^(overflow-x|overflow-y|overflow)-/, "$1"],
  [/^items-/, "items"],
  [/^justify-/, "justify"],
  [/^self-/, "self"],
  [/^(grow|shrink)(?:-|$)/, "$1"],
  [/^cursor-/, "cursor"],
  [/^select-/, "select"],
  [/^whitespace-/, "whitespace"],
  [/^leading-/, "leading"],
  [/^tracking-/, "tracking"],
  [/^(outline(?:-focus(?:-inset)?)?|outline-none)$/, "outline"],
  [/^duration-/, "duration"],
  [/^ease-/, "ease"],
  [/^(grid-cols|grid-rows|col-span|row-span)-/, "$1"],
  [/^(line-clamp)-/, "$1"],
];

/** The thing a class sets, under its variants; two classes with the same key conflict. */
export function classKey(token: string): string {
  const cut = token.lastIndexOf(":");
  const variants = cut === -1 ? "" : token.slice(0, cut + 1);
  const base = token
    .slice(cut + 1)
    .replace(/^!/, "")
    .replace(/^-/, "");
  return variants + group(base);
}

function group(base: string): string {
  if (DISPLAY.has(base)) return "display";
  if (POSITION.has(base)) return "position";
  if (base === "truncate") return "text-overflow";
  if (base.startsWith("text-")) {
    const value = base.slice(5);
    if (TYPE_ROLES.has(value)) return "text-role";
    if (TEXT_ALIGN.has(value)) return "text-align";
    return "text-colour";
  }
  if (base.startsWith("font-")) {
    const value = base.slice(5);
    return value === "regular" || value === "medium" ? "font-weight" : "font-family";
  }
  if (base === "border" || /^border-(?:\d+|x|y|t|r|b|l|s|e)(?:-\d+)?$/.test(base)) {
    return `border-width${base.replace(/^border(?:-(x|y|t|r|b|l|s|e))?.*$/, "-$1")}`;
  }
  if (base.startsWith("border-")) return "border-colour";
  if (/^flex-(?:row|col)(?:-reverse)?$/.test(base)) return "flex-direction";
  if (/^flex-(?:wrap|nowrap|wrap-reverse)$/.test(base)) return "flex-wrap";
  if (/^flex-/.test(base)) return "flex";
  for (const [pattern, name] of PREFIX_GROUPS) {
    const match = pattern.exec(base);
    if (match !== null) return name.replace("$1", match[1] ?? "");
  }
  return base;
}

function collect(value: ClassValue, out: string[]): void {
  if (value === null || value === undefined || value === false || value === true || value === 0)
    return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    for (const token of String(value).split(/\s+/)) if (token !== "") out.push(token);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value as readonly ClassValue[]) collect(item, out);
    return;
  }
  for (const [name, on] of Object.entries(value)) if (on) collect(name, out);
}

/** Joins class values; a later class wins over an earlier one that sets the same thing. */
export function cn(...values: ClassValue[]): string {
  const tokens: string[] = [];
  collect(values, tokens);
  const last = new Map<string, number>();
  tokens.forEach((token, index) => {
    last.set(classKey(token), index);
  });
  return tokens.filter((token, index) => last.get(classKey(token)) === index).join(" ");
}
