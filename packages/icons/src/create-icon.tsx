// createIcon: the one way Fin draws a glyph (spec 06 §5.1). Every icon carries the motion layer's
// classes (fin-ico, fin-ico--<Name>), its name in data-icon, and aria-hidden unless it is titled.
import type { ReactElement } from "react";
import { type GlyphName, glyphs } from "./glyphs.ts";

export type IconProps = {
  /** `bold` everywhere in the product; `fill` only for the current sidebar item. */
  weight?: "bold" | "fill";
  /**
   * Draws both weights and cross-fades between them (the sidebar's current item): `current`
   * shows the fill weight. Adds fin-ico--duo.
   */
  duo?: boolean;
  current?: boolean;
  /** Turns an ArrowClockwise as a spinner (fin-ico-spin). Ignored by every other glyph. */
  busy?: boolean;
  /** Makes the icon an image with this name. Without it the icon is decorative and hidden. */
  title?: string;
  /** CSS pixels; 16 in the product (12 in badges and meta lines). */
  size?: number;
  className?: string;
};

export type IconComponent = ((props: IconProps) => ReactElement) & { readonly glyph: GlyphName };

/** Builds the component for one glyph. */
export function createIcon(name: GlyphName): IconComponent {
  const paths = glyphs[name];
  function GlyphIcon(props: IconProps): ReactElement {
    const size = props.size ?? 16;
    const classes = ["fin-ico", `fin-ico--${name}`];
    if (props.duo === true) classes.push("fin-ico--duo");
    if (props.busy === true && name === "ArrowClockwise") classes.push("fin-ico-spin");
    if (props.className) classes.push(props.className);
    const titled = props.title !== undefined;
    const fill = props.current === true;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill="currentColor"
        focusable="false"
        className={classes.join(" ")}
        data-icon={name}
        data-weight={props.duo === true ? (fill ? "fill" : "bold") : undefined}
        role={titled ? "img" : undefined}
        aria-label={props.title}
        aria-hidden={titled ? undefined : true}
      >
        {props.duo === true ? (
          <>
            {paths.bold.map((d) => (
              <path key={`b${d}`} d={d} opacity={fill ? 0 : 1} />
            ))}
            {paths.fill.map((d) => (
              <path key={`f${d}`} d={d} opacity={fill ? 1 : 0} />
            ))}
          </>
        ) : (
          paths[props.weight ?? "bold"].map((d) => <path key={d} d={d} />)
        )}
      </svg>
    );
  }
  GlyphIcon.displayName = `${name}Icon`;
  return Object.assign(GlyphIcon, { glyph: name });
}

/** Draws a glyph by name, for data-driven places (navigation trees, status maps). */
export function Icon(props: IconProps & { name: GlyphName }): ReactElement {
  const { name, ...rest } = props;
  return createIcon(name)(rest);
}
