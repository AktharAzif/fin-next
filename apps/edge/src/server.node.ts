// The edge's one runtime entry (ARCHITECTURE §3.2): Vite's SSR build bundles this file into
// dist/server/main.js, which the image runs as dist/main.js.
import { runService } from "@fin/server";
import { edgeService } from "./main.ts";

void runService(edgeService);
