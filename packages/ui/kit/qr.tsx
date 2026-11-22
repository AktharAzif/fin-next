// The kit's QR code section (UR-13): the failed tile drawn still, a live QrCode, codes of other
// sizes, and a value no code holds. Each mounts on a press, so the spec can watch what a draw
// fetches (nothing) and what it reports. The section counts its own failure reports in
// data-reports, so the spec can tell one report from several.
import { useCallback, useState } from "react";
import { Button, FailureReporterProvider } from "../src/index.ts";
import { QrCode, QrCodeView } from "../src/lib/qr/qr-code.tsx";
import { KIT_QR_LABEL, KIT_QR_SIZES, KIT_QR_TOO_LONG, KIT_QR_VALUE } from "./qr-sample.ts";

export function QrSection() {
  const [still, setStill] = useState(false);
  const [live, setLive] = useState(false);
  const [sizes, setSizes] = useState(false);
  const [tooLong, setTooLong] = useState(false);
  const [draws, setDraws] = useState(0);
  const [reports, setReports] = useState(0);
  const report = useCallback(() => setReports((n) => n + 1), []);
  return (
    <FailureReporterProvider report={report}>
      <div className="flex flex-col gap-4" data-kit="qr-reports" data-reports={reports}>
        <div className="flex flex-wrap items-center gap-4" data-kit="qr-still">
          {still ? (
            <QrCodeView state={{ kind: "failed" }} label={KIT_QR_LABEL} />
          ) : (
            <Button variant="secondary" onClick={() => setStill(true)}>
              Show the failed state
            </Button>
          )}
        </div>
        <div
          className="flex flex-wrap items-center gap-4 rounded-md bg-surface-subtle p-4"
          data-kit="qr-live"
        >
          {live ? (
            <QrCode value={KIT_QR_VALUE} label={KIT_QR_LABEL} />
          ) : (
            <Button variant="secondary" onClick={() => setLive(true)}>
              Draw the QR code
            </Button>
          )}
        </div>
        <div
          className="flex flex-wrap items-start gap-4 rounded-md bg-surface-subtle p-4"
          data-kit="qr-sizes"
        >
          {sizes ? (
            KIT_QR_SIZES.map((value) => (
              <QrCode key={value.length} value={value} label={KIT_QR_LABEL} />
            ))
          ) : (
            <Button variant="secondary" onClick={() => setSizes(true)}>
              Draw codes of other sizes
            </Button>
          )}
        </div>
        <div
          className="flex flex-wrap items-center gap-4 rounded-md bg-surface-subtle p-4"
          data-kit="qr-too-long"
        >
          {tooLong ? (
            <>
              <QrCode value={KIT_QR_TOO_LONG} label={KIT_QR_LABEL} />
              <Button variant="secondary" onClick={() => setDraws((n) => n + 1)}>
                Draw the page again ({draws})
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setTooLong(true)}>
              Draw a value too long
            </Button>
          )}
        </div>
      </div>
    </FailureReporterProvider>
  );
}
