// The console's entry (spec 06 §2.3): the stylesheet first, then the scrubbing console guard, in
// place before any library is evaluated (vite.config.ts keeps it in a chunk of its own, so the
// build holds that order too), then the boot sequence, which fetches /env.json and /api/viewer in
// parallel, creates the router and replaces the static skeleton.
import "./styles.css";
import "@fin/frame/report";
import { consoleViewer } from "@fin/app-contracts";
import { startApp } from "@fin/frame";
import { createAppRouter } from "./router.ts";

void startApp({
  app: "console",
  viewer: consoleViewer,
  fallbackFrame: "app",
  createRouter: createAppRouter,
});
