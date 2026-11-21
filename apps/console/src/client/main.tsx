// The console's entry (spec 06 §2.3): the stylesheet first, then the boot sequence, which fetches
// /env.json and /api/viewer in parallel, creates the router and replaces the static skeleton.
import "./styles.css";
import { consoleViewer } from "@fin/app-contracts";
import { startApp } from "@fin/frame";
import { createAppRouter } from "./router.ts";

void startApp({
  app: "console",
  viewer: consoleViewer,
  fallbackFrame: "app",
  createRouter: createAppRouter,
});
