// Verify's entry (spec 06 §2.3, §7.3): the stylesheet, then the link token taken out of the
// fragment before anything else runs, then the boot sequence. Verify has no viewer: every page is a
// signed-out page in AuthFrame, and the link session is the API's (spec 03 §2.5).
import "./styles.css";
import "./link-token.ts";
import { startApp } from "@fin/frame";
import { createAppRouter } from "./router.ts";

void startApp({
  app: "verify",
  viewer: null,
  fallbackFrame: "auth",
  createRouter: createAppRouter,
});
