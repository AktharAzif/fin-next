# @fin/tokens

Fin's design tokens as CSS custom properties, the Tailwind 4 theme built on them, the base styles,
and the fonts (spec 06 §3.2).

| File | Holds |
|---|---|
| `tokens.css` | Every `--fin-*` value (203 of them), light on `:root`, dark on `[data-theme="dark"]` and under the system's dark preference; both densities; the reduced-motion durations |
| `theme.css` | Generated from `tokens.css` by `scripts/theme.ts` (`pnpm --filter @fin/tokens theme`): Tailwind's theme with its own scales cleared (`--*: initial`), Fin's utilities (`outline-focus`, `transition-press`, `z-header`, `divider-dotted-x`, the overlay and toast utilities) and the SDK state variants (`state-open:`, `state-checked:`...); `test/theme-file.test.ts` fails when it is stale |
| `base.css` | The page colour, body type, selection and the one focus ring |
| `fonts.css`, `fonts/` | Inter (variable) and Fira Mono (400, 500) as woff2 files, with `fonts/OFL.txt`; `fonts.css` is generated from the files by `scripts/fonts.ts` (fin-font-metrics 1.0.0, `pnpm --filter @fin/tokens fonts`), the "Inter Fallback" overrides computed from Inter's own tables and Arial's metrics; `test/fonts.test.ts` fails when it is stale |
| `export-pin/tokens.json` | The design system export's values, as it writes them; `test/tokens.test.ts` fails when `tokens.css` drifts from them |
| `vite.ts` | `finLayerOrder()`, the build plugin that keeps `@layer ui-sdk;` the first statement of every emitted stylesheet |

## An app's stylesheet

In this order and no other; the first line always:

```css
@layer ui-sdk;
@import "tailwindcss";
@import "@fin/tokens/tokens.css";
@import "@fin/tokens/theme.css";
@import "@fin/tokens/base.css";
@import "@fin/tokens/fonts.css";
@import "@fin/motion/fin-motion.css";
@source "../../index.html";
@source "../../../../packages/ui/src";
@source "../../../../packages/frame/src";
```

and `finLayerOrder()` from `@fin/tokens/vite` in the app's Vite plugins, after Tailwind's: Tailwind
puts its own `@layer properties;` ahead of every statement, and the plugin puts `@layer ui-sdk;`
back in front, so the built file starts with it (static:check, FW-C06).

## Changing a value

Values come from the design system. A change lands there first; then `export-pin/tokens.json` and
`tokens.css` change together in one reviewed pull request, and the drift and contrast tests say
whether they agree.

## Contrast (AC-UI-02, UR-21)

`test/tokens.test.ts` measures every pair spec 06 §9 names in both themes: text and status text on
each ground and on the hover and selected fills, badges on each ground and in hovered or selected
rows (4.5:1), and the focus ring, the borders of controls, the 1px ring of buttons and the solid
fills that mark a control (3:1). The export draws some of them below their ratio: the borders of
fields, checkboxes and a switch's track, the buttons' ring, tertiary text in a selected row, and in
dark some badges in hovered or selected rows. They are listed word for word, with both colours and
the ratio, in `test/below-ratio.ts`, and raised to the design system as UR-21. The test fails when
a pair is missing from the list, when a listed pair passes, and when a colour or a ratio changes.
AC-UI-02 is not met while the list holds a pair.

## Notes on the theme

- Under `prefers-reduced-motion: reduce`, every utility that transitions a transform or a size
  (`transition-press`, `transition-popup`, `transition-tooltip`, `transition-dialog`,
  `animate-copied`, `fin-toast`) keeps only its colour and opacity transitions, so a toast's place
  in the stack or a switch's thumb changes at once (spec 06 §5.1, AC-UI-13).
- `shadow-input` reads `--themed-shadow-input`, the export's input shadow with an empty shadow
  where the export says `none` (dark): Tailwind draws a shadow utility as one list with the ring
  utilities, and a `none` in that list would void the whole `box-shadow`, rings included.
