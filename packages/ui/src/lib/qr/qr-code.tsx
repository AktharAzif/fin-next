// QrCode (spec 06 §3.3's `qr` and §6.2; UR-13, [SA-45]; the Authenticator board's scan and qrFailed
// states): a QR code drawn as SVG <rect> elements, one for each run of dark modules in a row, on the
// board's 148px tile, which stays light in the dark theme and under forced colours so a camera sees
// dark modules on a light ground. The encoder comes with this file, so the code is drawn in the
// same render as the screen around it: nothing is fetched between an answer the screen gets once
// (an authenticator's set-up) and its drawing, and the screen's other way in, the key for manual
// entry, is never held up. Each module is a whole number of CSS pixels at a whole-pixel offset, so
// at a whole pixel ratio every engine paints each module on whole device pixels, exactly; at a
// fractional one (a zoomed page) a module's edges are painted grey, no darker than they are. A
// viewBox that scales a module to a fraction of a pixel, drawn with crispEdges, was rounded
// unevenly: too dark in WebKit to scan once the code was large. A value the encoder refuses shows
// why on the tile, with no "Try again", since a second try draws the same; it is reported once,
// with the component's ID and never the value. Nothing here makes an
// image URL or parses markup. The value (an otpauth: URI carries the shared secret) goes only into
// the drawing: never into an attribute, a label or a failure report. Screens import it from
// `@fin/ui/qr`, as the shell comes from `@fin/ui/shell`.
import { type ReactElement, useEffect, useMemo, useRef } from "react";
import { cn } from "../cn.ts";
import { useReportFailure } from "../failures.tsx";
import { encodeQr, type QrLevel, type QrMatrix } from "./encode.ts";

export type { QrLevel, QrMatrix } from "./encode.ts";

/** The IDs a failure report carries: which component, never what it drew. */
const REPORT_IDS = { component: "qr-code" } as const;

export type QrCodeState =
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly matrix: QrMatrix };

export interface QrRun {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** Each run of dark modules in a row, left to right and top to bottom: one rect each. */
export function darkRuns(matrix: QrMatrix): QrRun[] {
  const { size, modules } = matrix;
  const runs: QrRun[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (modules[y * size + x] !== 1) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && modules[y * size + x] === 1) x++;
      runs.push({ x: start, y, width: x - start });
    }
  }
  return runs;
}

/** The board's tile, a side in CSS pixels. */
export const QR_TILE_PX = 148;
/** The light margin left round the symbol inside the tile, in modules, at the least. */
export const QR_QUIET_MODULES = 2;
/** The smallest module drawn, in CSS pixels. */
export const QR_MIN_MODULE_PX = 2;

export interface QrGeometry {
  /** The tile's side in CSS pixels: the board's 148, more only for a symbol too big for it. */
  readonly tile: number;
  /** A module's side, in whole CSS pixels. */
  readonly module: number;
  /** From the tile's edge to the symbol's, in whole CSS pixels: the light margin. */
  readonly offset: number;
}

/**
 * Where a symbol of `size` modules a side sits on its tile: the largest whole number of pixels a
 * module that leaves the light margin inside 148px, never under 2px, the tile growing past 148px
 * when it must; the symbol centred, its offset rounded down to a whole pixel. Whole pixels at a
 * whole-pixel offset land on whole device pixels at every whole pixel ratio.
 */
export function qrGeometry(size: number): QrGeometry {
  const span = size + 2 * QR_QUIET_MODULES;
  const module = Math.max(QR_MIN_MODULE_PX, Math.floor(QR_TILE_PX / span));
  const tile = Math.max(QR_TILE_PX, module * span);
  return { tile, module, offset: Math.floor((tile - module * size) / 2) };
}

// The board's tile, with small corners: 148px (`size-37`) when it says it could not draw, and the
// drawing's own size when it draws, which no stretching parent widens (`size-fit`).
const TILE = "shrink-0 rounded-sm";

export interface QrCodeViewProps {
  state: QrCodeState;
  /** What the code is for, read by screen readers: "QR code for your authenticator app". */
  label: string;
  className?: string;
}

/** The tile in one of its two states, drawn from what it is given. */
export function QrCodeView(props: QrCodeViewProps): ReactElement {
  const { state } = props;
  if (state.kind === "failed") {
    return (
      <div
        data-slot="qr-code"
        data-state="failed"
        className={cn(
          TILE,
          "grid size-37 place-items-center bg-fill-selected p-4 text-center text-caption text-text-secondary",
          props.className,
        )}
      >
        <p className="m-0">Couldn’t draw the QR code. Type the key instead.</p>
      </div>
    );
  }
  const { size } = state.matrix;
  const { tile, module, offset } = qrGeometry(size);
  // `forced-color-adjust-none`: a forced palette (a contrast theme) would otherwise paint the
  // tile in its Canvas and the modules in its CanvasText, light on dark in a dark one.
  return (
    <div
      data-slot="qr-code"
      data-state="ready"
      data-theme="light"
      className={cn(
        TILE,
        "size-fit bg-surface-raised text-text-primary forced-color-adjust-none",
        props.className,
      )}
    >
      <svg
        role="img"
        aria-label={props.label}
        width={tile}
        height={tile}
        viewBox={`0 0 ${tile} ${tile}`}
        fill="currentColor"
        className="block"
      >
        {darkRuns(state.matrix).map((run) => (
          <rect
            key={`${run.y}.${run.x}`}
            x={offset + run.x * module}
            y={offset + run.y * module}
            width={run.width * module}
            height={module}
          />
        ))}
      </svg>
    </div>
  );
}

export interface QrCodeProps {
  /** The text to encode. It is drawn and nothing else: no attribute, label or report holds it. */
  value: string;
  /** What the code is for, read by screen readers. */
  label: string;
  /** The error correction level; M by default, as the Authenticator board's code is drawn. */
  level?: QrLevel;
  className?: string;
}

type Drawn = { readonly matrix: QrMatrix } | { readonly error: unknown };

/** A QR code of `value`, drawn as SVG elements in the same render. */
export function QrCode(props: QrCodeProps): ReactElement {
  const { value, level = "M" } = props;
  const report = useReportFailure();
  const drawn = useMemo((): Drawn => {
    try {
      return { matrix: encodeQr(value, { level }) };
    } catch (error) {
      return { error };
    }
  }, [value, level]);

  // A value the encoder refuses is reported once, however often the screen around it draws again.
  const reported = useRef<{ readonly value: string; readonly level: QrLevel } | null>(null);
  useEffect(() => {
    if (!("error" in drawn)) return;
    const last = reported.current;
    if (last !== null && last.value === value && last.level === level) return;
    reported.current = { value, level };
    report(drawn.error, REPORT_IDS);
  }, [drawn, value, level, report]);

  return (
    <QrCodeView
      state={"error" in drawn ? { kind: "failed" } : { kind: "ready", matrix: drawn.matrix }}
      label={props.label}
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}
