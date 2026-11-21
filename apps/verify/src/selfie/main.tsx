// The selfie host's entry (spec 06 §1.2, §7.3; FW-C20): the stylesheet, then the ticket taken out of
// the fragment before anything else runs, then the boot sequence. Like verify it has no viewer: the
// page is a signed-out card in AuthFrame, and the selfie session is the API's (spec 03 §2.6).
import "./styles.css";
import "./ticket.ts";
import { startApp } from "@fin/frame";
import { createSelfieRouter } from "./router.tsx";

void startApp({
  app: "verify",
  viewer: null,
  fallbackFrame: "auth",
  createRouter: createSelfieRouter,
});
