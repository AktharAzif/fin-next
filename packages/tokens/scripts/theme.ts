// Builds theme.css from tokens.css (spec 06 §3.2). `pnpm --filter @fin/tokens theme` runs it
// (scripts/write-theme.ts); test/theme-file.test.ts fails unless the committed theme.css is, as a
// whole and byte for byte, what this builds from the committed tokens.css.
//
// THE MAPPING RULE. It takes the names tokens.css declares on `:root, [data-theme="light"]` and on
// `:root`, in the file's order, and maps every name under a family's prefix as this table says;
// `<n>` is the rest of the name, kept as it is. A name under no prefix here is not mapped (the
// other --fin-space-*, --fin-ease-*, --fin-motion-*, --fin-focus-*, --fin-divider-*: the utilities
// and base.css read those as tokens).
//
//   family    reads                          strips          maps to (Tailwind theme namespace)
//   colour    --fin-color-<n>                --fin-color-    --color-<n>
//   font      --fin-font-<n>                 --fin-font-     --font-<n>: a family, or a weight
//                                                            as --font-weight-<w>
//   type      --fin-text-<role>-size         --fin-text-     --text-<role>
//             --fin-text-<role>-line-height  and the part    --text-<role>--line-height
//             --fin-text-<role>-tracking     after <role>    --text-<role>--letter-spacing
//             --fin-text-<role>-weight                       --text-<role>--font-weight
//   radius    --fin-radius-<n>               --fin-radius-   --radius-<n>
//   shadow    --fin-shadow-<n>               --fin-shadow-   --shadow-<n> (stand-ins: below)
//   layout    --fin-layout-<n>               --fin-layout-   --spacing-<n>
//   density   --fin-density-<n>              --fin-density-  --spacing-<n>
//   grid      --fin-space-unit               the whole name  --spacing
//   z layer   --fin-z-<n>                    --fin-z-        none: `@utility z-<n>`
//   duration  --fin-duration-<n>             --fin-duration- none: `@utility duration-<n>`
//
// A type role is a `-size` name; its other three names must exist, or buildTheme throws. A role's
// `-family` is not mapped: `font-*` sets the family.
//
// The classes the code uses (packages/ui, packages/frame, packages/icons, the apps' client code and
// the kit) read them as `bg-*`, `text-*`, `border-*`, `ring-*` and `decoration-*`; `text-<role>`;
// `font-*`; `rounded-*`; `shadow-*`; the spacing scale and spacing names (`h-header`, `w-sidebar`,
// `max-w-form`, `h-control-md`, `h-row`); `z-*`; `duration-*`.
//
// WHAT IT ADDS. In `@theme inline`: `--*: initial` (Tailwind's own scales cleared), the four
// breakpoints S6-21 keeps (BREAKPOINTS), and the defaults --default-font-family (--fin-font-sans),
// --default-mono-font-family (--fin-font-mono), --default-transition-duration (--fin-duration-fast)
// and --default-transition-timing-function (--fin-ease-out). Outside it: a --themed-shadow-<n>
// stand-in, per theme as tokens.css, for each shadow the export says is `none` in some theme; the
// `fin-spinner-turn` keyframes; the `@utility` rules (the z layers and durations above, then
// OWN_UTILITIES, each transition with its reduced-motion block written by `utility()`); and the SDK
// state variants, `@custom-variant state-<name> (&[<attribute>])` (STATE_VARIANTS).
//
// THE VALUES. Every value a token is mapped to is `var(--fin-<token>)`, and a shadow stand-in is
// `var(--fin-shadow-<n>)` or the empty shadow `0 0 #0000`: no token's value is copied into
// theme.css. The only literals are `--*: initial`, the breakpoints' widths (a media query cannot
// read a custom property), the empty shadow and the utilities' own constants. buildTheme throws
// when a `var(--fin-*)` it writes names a token tokens.css does not declare.

/** A rule body's custom properties, in order, values with their white space folded. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]*);/g)) {
    out.set(match[1] ?? "", (match[2] ?? "").replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Every style rule, with the at-rule around it ("" at the top level), comments removed. */
function rules(css: string): { context: string; selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { context: string; selector: string; body: string }[] = [];
  const walk = (part: string, context: string) => {
    let at = 0;
    for (let open = part.indexOf("{", at); open !== -1; open = part.indexOf("{", at)) {
      let depth = 1;
      let end = open + 1;
      for (; end < part.length && depth > 0; end++) {
        if (part[end] === "{") depth++;
        else if (part[end] === "}") depth--;
      }
      const prelude = part.slice(at, open).replace(/\s+/g, " ").trim();
      const body = part.slice(open + 1, end - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else out.push({ context, selector: prelude, body });
      at = end;
    }
  };
  walk(text, "");
  return out;
}

const LIGHT = ':root, [data-theme="light"]';
const DARK = '[data-theme="dark"]';
const SYSTEM_DARK = ':root:not([data-theme="light"])';
const PREFERS_DARK = "@media (prefers-color-scheme: dark)";
const ROOT = ":root";

/** The breakpoints Tailwind names, at the widths S6-21 keeps. */
const BREAKPOINTS: [string, string][] = [
  ["sm", "40rem"],
  ["md", "48rem"],
  ["lg", "64rem"],
  ["xl", "80rem"],
];

/** The SDK state variants (spec 06 §3.2), each on the attribute the SDK sets. */
const STATE_VARIANTS: [string, string][] = [
  ["open", "data-open"],
  ["closed", "data-closed"],
  ["instant", "data-instant"],
  ["active", "data-selected"],
  ["checked", "data-checked"],
  ["starting", "data-starting-style"],
  ["ending", "data-ending-style"],
  ["highlighted", "data-highlighted"],
  ["disabled", "data-disabled"],
  ["invalid", "data-invalid"],
  ["pending", "data-pending"],
];

/** The properties whose transitions move, turn, scale or resize something. */
const MOVING = new Set(["translate", "rotate", "scale", "transform", "height", "width"]);
const REDUCE = "@media (prefers-reduced-motion: reduce)";

type Utility = {
  name: string;
  comment: string;
  body: [string, string][];
  nested?: { prelude: string; body: [string, string][] }[];
};

/** A transition utility: a duration utility (`duration-*`) and an ease set on the element win. */
function transition(
  name: string,
  comment: string,
  properties: string[],
  duration: string,
  extra: [string, string][] = [],
): Utility {
  return {
    name,
    comment,
    body: [
      ["transition-property", properties.join(", ")],
      ["transition-duration", `var(--tw-duration, var(${duration}))`],
      ["transition-timing-function", "var(--tw-ease, var(--fin-ease-out))"],
      ...extra,
    ],
  };
}

/** Fin's own utilities, written from spec 06 §3.3, §5.1 and §9 and the export's motion values. */
const OWN_UTILITIES: Utility[] = [
  {
    name: "outline-focus",
    comment: "The one focus ring (spec 06 §9): 2px of focus-ring, 2px outside.",
    body: [
      ["outline", "var(--fin-focus-width) solid var(--fin-color-focus-ring)"],
      ["outline-offset", "var(--fin-focus-offset)"],
    ],
  },
  {
    name: "outline-focus-inset",
    comment: "The same ring drawn inside, where an outside one would be clipped (rows, tabs).",
    body: [
      ["outline", "var(--fin-focus-width) solid var(--fin-color-focus-ring)"],
      ["outline-offset", "calc(var(--fin-focus-width) * -1)"],
    ],
  },
  transition(
    "transition-press",
    "A button: its colours and shadow, and its scale as it is pressed.",
    [
      "color",
      "background-color",
      "border-color",
      "text-decoration-color",
      "box-shadow",
      "opacity",
      "scale",
    ],
    "--fin-duration-fast",
  ),
  transition(
    "transition-field",
    "A field, checkbox or switch track: its colours, border and shadow.",
    ["color", "background-color", "border-color", "box-shadow"],
    "--fin-duration-fast",
  ),
  transition(
    "transition-fade",
    "A fade: a backdrop, or a tab's text.",
    ["opacity", "color", "background-color"],
    "--fin-duration-base",
  ),
  transition(
    "transition-popup",
    "A menu or popover from its trigger, or a switch's thumb.",
    ["opacity", "scale", "translate"],
    "--fin-duration-base",
  ),
  transition("transition-tooltip", "A tooltip.", ["opacity", "scale"], "--fin-duration-fast"),
  transition(
    "transition-dialog",
    "A dialog in the top layer: it fades and scales, then leaves the top layer.",
    ["opacity", "scale", "translate", "display", "overlay"],
    "--fin-duration-slow",
    [["transition-behavior", "allow-discrete"]],
  ),
  transition(
    "animate-copied",
    "CopyField's icons crossing over as a copy succeeds (300ms).",
    ["opacity", "scale"],
    "--fin-motion-swap",
  ),
  {
    name: "animate-spin-fin",
    comment: "A spinner: one turn every 600ms, under reduced motion too.",
    body: [["animation", "fin-spinner-turn var(--fin-motion-spin) linear infinite"]],
  },
  {
    name: "scale-press",
    comment: "A pressed button.",
    body: [["scale", "var(--fin-motion-press-scale)"]],
  },
  {
    name: "scale-pop",
    comment: "A popup's or a dialog's size as it opens and closes.",
    body: [["scale", "var(--fin-motion-pop-scale)"]],
  },
  {
    name: "origin-popup",
    comment: "A popup grows from its anchor: the SDK sets --transform-origin on it.",
    body: [["transform-origin", "var(--transform-origin)"]],
  },
  {
    name: "max-h-available",
    comment: "A popup no taller than the room the SDK measured for it.",
    body: [["max-height", "var(--available-height)"]],
  },
  {
    name: "divider-dotted-x",
    comment: "A dotted horizontal rule, 1px dots 5px apart.",
    body: [
      ["--dotted-colour", "var(--fin-color-border-strong)"],
      ["--dotted-dash", "var(--fin-divider-dotted-dash)"],
      ["--dotted-period", "calc(var(--fin-divider-dotted-dash) + var(--fin-divider-dotted-gap))"],
      ["height", "var(--fin-divider-width)"],
      [
        "background-image",
        "linear-gradient(to right, var(--dotted-colour) var(--dotted-dash), #0000 0)",
      ],
      ["background-size", "var(--dotted-period) var(--fin-divider-width)"],
      ["background-repeat", "repeat-x"],
    ],
  },
  {
    name: "fin-toast-region",
    comment:
      "The toast region: 480px, bottom centre, 24px up (16px from each edge on a phone), as tall as the front toast, or the whole stack while it is expanded. The SDK places it.",
    body: [
      [
        "--toast-region-inset",
        "calc(var(--keyboard-inset, 0px) + env(safe-area-inset-bottom, 0px))",
      ],
      ["top", "auto"],
      ["bottom", "calc(var(--fin-layout-toast-offset) + var(--toast-region-inset))"],
      ["width", "min(var(--fin-layout-toast), calc(100vw - 2 * var(--fin-space-16)))"],
      ["height", "var(--toast-front-height)"],
      ["margin", "0"],
      ["padding", "0"],
      ["border", "0"],
      ["background", "transparent"],
      ["overflow", "visible"],
    ],
    nested: [
      {
        prelude: "&[data-expanded]",
        body: [
          [
            "height",
            "calc(var(--toast-stack-height) + (var(--toast-count) - 1) * var(--fin-space-8))",
          ],
        ],
      },
    ],
  },
  {
    name: "fin-toast",
    comment:
      "A toast in the stack the SDK measures (--toast-index, --toast-offset, --toast-height): the ones behind the front toast peek out above it, scaled down; the stack spreads out while it is expanded; the front toast rises in from below and a leaving one fades.",
    body: [
      ["--toast-peek-y", "calc(var(--toast-index) * var(--fin-space-8) * -1)"],
      ["position", "absolute"],
      ["inset-inline", "0"],
      ["bottom", "0"],
      ["z-index", "calc(100 - var(--toast-index))"],
      ["overflow", "hidden"],
      ["height", "var(--toast-height)"],
      ["translate", "0 var(--toast-peek-y)"],
      ["scale", "calc(1 - var(--toast-index) * 0.05)"],
      ["transition-property", "opacity, translate, scale, height"],
      ["transition-duration", "var(--fin-duration-base)"],
      ["transition-timing-function", "var(--fin-ease-out)"],
    ],
    nested: [
      {
        prelude: "&:not([data-front], [data-expanded])",
        body: [["height", "var(--toast-front-height)"]],
      },
      {
        prelude: "&[data-expanded]",
        body: [
          [
            "--toast-peek-y",
            "calc((var(--toast-offset) + var(--toast-index) * var(--fin-space-8)) * -1)",
          ],
          ["scale", "1"],
        ],
      },
      { prelude: "&[data-starting-style]", body: [["transition-duration", "0s"]] },
      {
        prelude: "&[data-starting-style][data-front]",
        body: [["--toast-peek-y", "var(--fin-motion-toast-offset)"]],
      },
      {
        prelude: "&:is([data-starting-style]:not([data-front]), [data-ending-style])",
        body: [["opacity", "0"]],
      },
    ],
  },
];

/** The token families, read from tokens.css: the names under each prefix, in the file's order. */
function family(names: string[], prefix: string): string[] {
  return names.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
}

function block(selector: string, lines: string[], indent = ""): string {
  return `${indent}${selector} {\n${lines.map((line) => `${indent}  ${line}\n`).join("")}${indent}}\n`;
}

/** One declaration; a list too long for a 100-column line goes on its own line, as Biome sets it. */
function declaration(indent: string, name: string, value: string): string {
  const line = `${indent}${name}: ${value};`;
  return line.length <= 100 ? line : `${indent}${name}:\n${indent}  ${value};`;
}

/** A comment, wrapped at 100 columns. */
function comment(text: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + word.length + 4 > 100) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  lines.push(line);
  return lines.length === 1
    ? `/* ${line} */\n`
    : `/*\n${lines.map((l) => ` * ${l}\n`).join("")} */\n`;
}

function utility(u: Utility): string {
  const lines = u.body.map(([name, value]) => declaration("  ", name, value));
  const reduced = u.body.find(([name]) => name === "transition-property")?.[1].split(", ") ?? [];
  const kept = reduced.filter((p) => !MOVING.has(p));
  const nested = [...(u.nested ?? [])];
  if (kept.length !== reduced.length) {
    nested.push({ prelude: REDUCE, body: [["transition-property", kept.join(", ")]] });
  }
  for (const n of nested) {
    lines.push(`  ${n.prelude} {`);
    for (const [name, value] of n.body) lines.push(declaration("    ", name, value));
    lines.push("  }");
  }
  return `${comment(u.comment)}@utility ${u.name} {\n${lines.join("\n")}\n}\n`;
}

/** theme.css, from the text of tokens.css. Throws when a token the file reads is missing. */
export function buildTheme(tokensCss: string): string {
  const all = rules(tokensCss);
  const find = (selector: string, context = "") => {
    const found = all.filter((r) => r.selector === selector && r.context === context);
    if (found.length !== 1) throw new Error(`tokens.css: no single rule ${selector} ${context}`);
    return declarations(found[0]?.body ?? "");
  };
  const light = find(LIGHT);
  const dark = find(DARK);
  const systemDark = find(SYSTEM_DARK, PREFERS_DARK);
  const root = find(ROOT);
  const names = [...new Set([...light.keys(), ...root.keys()])];
  const declared = new Set(names);

  const theme: string[] = ["--*: initial;"];
  theme.push(...BREAKPOINTS.map(([name, width]) => `--breakpoint-${name}: ${width};`));
  if (!declared.has("--fin-space-unit")) throw new Error("tokens.css: no --fin-space-unit");
  theme.push("--spacing: var(--fin-space-unit);");
  for (const name of family(names, "--fin-color-")) {
    theme.push(`--color-${name}: var(--fin-color-${name});`);
  }
  // Families (`font-sans`, `font-mono`) and weights (`font-medium`), as Tailwind names both.
  for (const name of family(names, "--fin-font-")) {
    theme.push(`--font-${name}: var(--fin-font-${name});`);
  }
  theme.push("--default-font-family: var(--fin-font-sans);");
  theme.push("--default-mono-font-family: var(--fin-font-mono);");
  for (const size of family(names, "--fin-text-").filter((n) => n.endsWith("-size"))) {
    const role = size.slice(0, -"-size".length);
    theme.push(`--text-${role}: var(--fin-text-${role}-size);`);
    for (const [part, sub] of [
      ["line-height", "line-height"],
      ["tracking", "letter-spacing"],
      ["weight", "font-weight"],
    ]) {
      const token = `--fin-text-${role}-${part}`;
      if (!declared.has(token)) throw new Error(`tokens.css: no ${token}`);
      theme.push(`--text-${role}--${sub}: var(${token});`);
    }
  }
  for (const name of family(names, "--fin-radius-")) {
    theme.push(`--radius-${name}: var(--fin-radius-${name});`);
  }
  // A shadow the export says is `none` in a theme reads a stand-in: Tailwind draws a shadow in one
  // list with the ring utilities, and a `none` in that list would void the whole box-shadow.
  const standIns: string[] = [];
  for (const name of family(names, "--fin-shadow-")) {
    const token = `--fin-shadow-${name}`;
    const none = [light, dark, systemDark].some((values) => values.get(token) === "none");
    if (none) standIns.push(name);
    theme.push(`--shadow-${name}: var(--${none ? "themed" : "fin"}-shadow-${name});`);
  }
  for (const prefix of ["--fin-layout-", "--fin-density-"]) {
    for (const name of family(names, prefix))
      theme.push(`--spacing-${name}: var(${prefix}${name});`);
  }
  theme.push("--default-transition-duration: var(--fin-duration-fast);");
  theme.push("--default-transition-timing-function: var(--fin-ease-out);");

  const utilities: Utility[] = [
    ...family(names, "--fin-z-").map((name) => ({
      name: `z-${name}`,
      comment: `The ${name} layer, in the page (overlays use the top layer).`,
      body: [["z-index", `var(--fin-z-${name})`]] as [string, string][],
    })),
    ...family(names, "--fin-duration-").map((name) => ({
      name: `duration-${name}`,
      comment: `The ${name.replace("-", " ")} duration.`,
      body: [
        ["--tw-duration", `var(--fin-duration-${name})`],
        ["transition-duration", `var(--fin-duration-${name})`],
      ] as [string, string][],
    })),
    ...OWN_UTILITIES,
  ];
  const text = utilities.map(utility).join("\n");

  const themed = (values: Map<string, string>) =>
    standIns.map((name) => {
      const token = `--fin-shadow-${name}`;
      return `--themed-shadow-${name}: ${values.get(token) === "none" ? "0 0 #0000" : `var(${token})`};`;
    });

  const css = [
    "/*\n * @fin/tokens theme.css: generated by scripts/theme.ts from tokens.css (spec 06 §3.2). Do not\n * edit it by hand: change tokens.css or the script, then run `pnpm --filter @fin/tokens theme`.\n * test/theme-file.test.ts fails when this file is stale.\n */\n",
    block("@theme inline", theme),
    "\n/* The stand-ins for shadows the export says are `none` in a theme, per theme as tokens.css. */\n",
    block(':root,\n[data-theme="light"]', themed(light)),
    "\n",
    block(DARK, themed(dark)),
    "\n",
    `${PREFERS_DARK} {\n${block(SYSTEM_DARK, themed(systemDark), "  ")}}\n`,
    "\n/* A spinner's turn. */\n",
    "@keyframes fin-spinner-turn {\n  to {\n    rotate: 360deg;\n  }\n}\n",
    "\n",
    text,
    "\n/* The SDK's state attributes as variants (spec 06 §3.2). */\n",
    ...STATE_VARIANTS.map(
      ([name, attribute]) => `@custom-variant state-${name} (&[${attribute}]);\n`,
    ),
  ].join("");
  // The whole file, the theme's defaults included: every token it reads is one tokens.css declares.
  for (const match of css.matchAll(/var\((--fin-[a-z0-9-]+)/g)) {
    if (!declared.has(match[1] ?? "")) throw new Error(`tokens.css: no ${match[1]}`);
  }
  return css;
}
