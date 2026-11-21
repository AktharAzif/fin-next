# @fin/tokens

Fin's design tokens as CSS custom properties, the Tailwind 4 theme built on them, the base styles,
and the fonts (spec 06 §3.2).

| File | Holds |
|---|---|
| `tokens.css` | Every `--fin-*` value (203 of them), light on `:root`, dark on `[data-theme="dark"]` and under the system's dark preference; both densities; the reduced-motion durations |
| `theme.css` | Tailwind's theme with its own scales cleared (`--*: initial`), Fin's utilities (`outline-focus`, `transition-press`, `z-header`, `divider-dotted-x`, the overlay and toast utilities) and the SDK state variants (`state-open:`, `state-checked:`...) |
| `base.css` | The page colour, body type, selection and the one focus ring |
| `fonts.css`, `fonts/` | Inter (variable) and Fira Mono (400, 500) as woff2 files, with `fonts/OFL.txt` |
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
