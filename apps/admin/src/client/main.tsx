// Fin Admin's entry (spec 06 §2.3): the stylesheet first, then the scrubbing console guard, in place
// before any library is evaluated (vite.config.ts keeps it in a chunk of its own, so the build
// holds that order too), then the boot sequence, which fetches /env.json and /api/viewer in
// parallel, creates the router and replaces the static skeleton. Its api() does not follow
// redirects: an opaque one means Access ended the session, and the page reloads.
import "./styles.css";
import "@fin/frame/report";
import { staffViewer } from "@fin/app-contracts";
import { startApp } from "@fin/frame";
import { createAppRouter } from "./router.ts";

void startApp({
  app: "admin",
  viewer: staffViewer,
  fallbackFrame: "app",
  createRouter: createAppRouter,
});
