// The brand marks: the Fin.com lockup, the F mark, and the Google mark for "Continue with Google".
// Fin's marks are reserved (NOTICE.md); they draw in currentColor so the theme's text-primary inks
// them. With `label` they are images with that name; without, decorative.
import type { ReactElement } from "react";
import { lockupArt, markArt } from "./brand-art.ts";
import { glyphs } from "./glyphs.ts";

type MarkProps = { height?: number; label?: string; className?: string };

function aspect(viewBox: string): number {
  const [, , w = 1, h = 1] = viewBox.split(/\s+/).map(Number);
  return w / h;
}

function Mark(
  props: MarkProps & { art: { viewBox: string; d: string }; kind: string; fallbackHeight: number },
) {
  const height = props.height ?? props.fallbackHeight;
  const width = Math.round(height * aspect(props.art.viewBox) * 100) / 100;
  const labelled = props.label !== undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={props.art.viewBox}
      fill="currentColor"
      focusable="false"
      className={props.className}
      data-brand={props.kind}
      role={labelled ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={labelled ? undefined : true}
    >
      <path d={props.art.d} />
    </svg>
  );
}

/** The Fin.com lockup: the F mark and the wordmark, 18px high on the expanded sidebar. */
export function FinLockup(props: MarkProps): ReactElement {
  return <Mark {...props} art={lockupArt} kind="lockup" fallbackHeight={18} />;
}

/** The F mark alone: 24px on the rail (UR-04), 18px in the phone header. Never below 16px. */
export function FinMark(props: MarkProps): ReactElement {
  return <Mark {...props} art={markArt} kind="mark" fallbackHeight={24} />;
}

/** The Google mark beside "Continue with Google": Phosphor's GoogleLogo glyph. It never moves. */
export function GoogleMark(props: { size?: number; className?: string }): ReactElement {
  const size = props.size ?? 16;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      focusable="false"
      aria-hidden="true"
      className={props.className}
      data-brand="google"
    >
      {glyphs.GoogleLogo.bold.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
