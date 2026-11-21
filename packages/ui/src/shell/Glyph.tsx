// Draws a shell glyph at 16px in currentColor, with the motion layer's classes (`fin-ico
// fin-ico--<Name>`, shell-v2 §7.1). Every glyph is decorative: the control around it carries the
// name. The sidebar's items use NavGlyph, which draws both weights so the current item's icon
// cross-fades from bold to fill (`fin-ico--duo`).
import { classes } from "./classes.ts";
import { type ShellGlyphName, type ShellNavGlyphName, shellGlyphs } from "./glyph-data.ts";

const SVG = { viewBox: "0 0 256 256", width: 16, height: 16, fill: "currentColor" } as const;

export interface GlyphProps {
  name: ShellGlyphName;
  className?: string;
}

export function Glyph({ name, className }: GlyphProps) {
  return (
    <svg
      {...SVG}
      aria-hidden="true"
      focusable="false"
      className={classes("fin-ico", `fin-ico--${name}`, "shrink-0", className)}
    >
      {shellGlyphs[name].bold.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export interface NavGlyphProps {
  name: ShellNavGlyphName;
  /** The current item's icon is the fill weight. */
  current: boolean;
  className?: string;
}

export function NavGlyph({ name, current, className }: NavGlyphProps) {
  const paths = shellGlyphs[name];
  return (
    <svg
      {...SVG}
      aria-hidden="true"
      focusable="false"
      data-weight={current ? "fill" : "bold"}
      className={classes("fin-ico", `fin-ico--${name}`, "fin-ico--duo", "shrink-0", className)}
    >
      {paths.bold.map((d) => (
        <path key={`b${d}`} d={d} className="fin-ico__bold" opacity={current ? 0 : 1} />
      ))}
      {paths.fill.map((d) => (
        <path key={`f${d}`} d={d} className="fin-ico__fill" opacity={current ? 1 : 0} />
      ))}
    </svg>
  );
}
