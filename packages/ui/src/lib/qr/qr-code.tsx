// QrCode (spec 06 §3.3's `qr` and §6.2; UR-13, [SA-45]; the Authenticator board's scan, qrLoading
// and qrFailed states): a QR code drawn as SVG <rect> elements, one for each run of dark modules in
// a row, on the board's 148px tile, which stays light in the dark theme so a camera sees dark
// modules on a light ground. The encoder is its own chunk, fetched when a code is first drawn: the
// tile shows a placeholder while it loads, and "Try again" when it could not load or draw, so the
// screen's other way in, the key for manual entry, is never held up. Nothing here makes an image
// URL or parses markup. The value (an otpauth: URI carries the shared secret) goes only into the
// drawing: never into an attribute, a label or a failure report. Screens import it from
// `@fin/ui/qr`, as the shell comes from `@fin/ui/shell`.
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { Button } from "../../foundation/button.tsx";
import { Skeleton } from "../../foundation/skeleton.tsx";
import { useAnnounceOnMount } from "../announce.ts";
import { cn } from "../cn.ts";
import { useReportFailure } from "../failures.tsx";
import type { encodeQr, QrLevel, QrMatrix } from "./encode.ts";

export type { QrLevel, QrMatrix } from "./encode.ts";

interface Encoder {
  readonly encodeQr: typeof encodeQr;
}

/** The encoder once its chunk has loaded, so every later code draws on the first render. */
let loaded: Encoder | null = null;

async function loadEncoder(): Promise<Encoder> {
  loaded ??= await import("./encode.ts");
  return loaded;
}

/** The IDs a failure report carries: which component, never what it drew. */
const REPORT_IDS = { component: "qr-code" } as const;

export type QrCodeState =
  | { readonly kind: "loading" }
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

// The board's tile: 148px square with small corners; the symbol fills it inside a 6px margin.
const TILE = "size-37 shrink-0 rounded-sm";

export interface QrCodeViewProps {
  state: QrCodeState;
  /** What the code is for, read by screen readers: "QR code for your authenticator app". */
  label: string;
  /** "Try again" in the failed state. */
  onRetry?: () => void;
  className?: string;
}

function QrLoading(props: { className?: string | undefined }) {
  useAnnounceOnMount("Loading the QR code");
  return (
    <div
      data-slot="qr-code"
      data-state="loading"
      aria-busy="true"
      className={cn(TILE, props.className)}
    >
      <span className="sr-only">Loading the QR code</span>
      <Skeleton shape="block" className="h-full w-full rounded-sm" />
    </div>
  );
}

/** The tile in one of its three states, drawn from what it is given. */
export function QrCodeView(props: QrCodeViewProps): ReactElement {
  const { state } = props;
  if (state.kind === "loading") return <QrLoading className={props.className} />;
  if (state.kind === "failed") {
    return (
      <div
        data-slot="qr-code"
        data-state="failed"
        className={cn(TILE, "grid place-items-center bg-fill-selected", props.className)}
      >
        <span className="sr-only">Couldn’t draw the QR code. Type the key instead.</span>
        <Button
          variant="secondary"
          size="sm"
          reportIds={REPORT_IDS}
          {...(props.onRetry === undefined ? {} : { onClick: props.onRetry })}
        >
          Try again
        </Button>
      </div>
    );
  }
  const { size } = state.matrix;
  return (
    <div
      data-slot="qr-code"
      data-state="ready"
      data-theme="light"
      className={cn(TILE, "bg-surface-raised p-1.5 text-text-primary", props.className)}
    >
      <svg
        role="img"
        aria-label={props.label}
        viewBox={`0 0 ${size} ${size}`}
        fill="currentColor"
        shapeRendering="crispEdges"
        className="block size-full"
      >
        {darkRuns(state.matrix).map((run) => (
          <rect key={`${run.y}.${run.x}`} x={run.x} y={run.y} width={run.width} height={1} />
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

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly encoder: Encoder };

/** A QR code of `value`: the encoder fetched on first use, the drawing as SVG elements. */
export function QrCode(props: QrCodeProps): ReactElement {
  const { value, level = "M" } = props;
  const report = useReportFailure();
  const [load, setLoad] = useState<Load>(() =>
    loaded === null ? { kind: "loading" } : { kind: "loaded", encoder: loaded },
  );

  useEffect(() => {
    if (load.kind !== "loading") return;
    let current = true;
    loadEncoder().then(
      (encoder) => {
        if (current) setLoad({ kind: "loaded", encoder });
      },
      (error: unknown) => {
        if (!current) return;
        report(error, REPORT_IDS);
        setLoad({ kind: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [load.kind, report]);

  // A new `load` object on every retry draws again, even when the encoder was already here.
  const drawn = useMemo((): { matrix: QrMatrix } | { error: unknown } | null => {
    if (load.kind !== "loaded") return null;
    try {
      return { matrix: load.encoder.encodeQr(value, { level }) };
    } catch (error) {
      return { error };
    }
  }, [load, value, level]);

  useEffect(() => {
    if (drawn !== null && "error" in drawn) report(drawn.error, REPORT_IDS);
  }, [drawn, report]);

  const state: QrCodeState =
    load.kind === "failed" || (drawn !== null && "error" in drawn)
      ? { kind: "failed" }
      : drawn === null
        ? { kind: "loading" }
        : { kind: "ready", matrix: drawn.matrix };
  return (
    <QrCodeView
      state={state}
      label={props.label}
      onRetry={() => setLoad({ kind: "loading" })}
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}
