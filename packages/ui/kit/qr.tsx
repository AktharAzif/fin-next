// The kit's QR code section (UR-13): the tile's placeholder and failed states drawn still, and a
// live QrCode. Each mounts on a press: the placeholder says "Loading the QR code" as it mounts,
// which must not land in the other cases' announcements, and the live code's chunk must wait until
// the spec has had the chance to hold it back or refuse it.
import { useState } from "react";
import { Button, QrCode, QrCodeView } from "../src/index.ts";
import { KIT_QR_LABEL, KIT_QR_VALUE } from "./qr-sample.ts";

export function QrSection() {
  const [still, setStill] = useState(false);
  const [live, setLive] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4" data-kit="qr-still">
        {still ? (
          <>
            <QrCodeView state={{ kind: "loading" }} label={KIT_QR_LABEL} />
            <QrCodeView state={{ kind: "failed" }} label={KIT_QR_LABEL} onRetry={() => {}} />
          </>
        ) : (
          <Button variant="secondary" onClick={() => setStill(true)}>
            Show the other states
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
    </div>
  );
}
