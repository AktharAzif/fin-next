// The thin adapter to packages/web-host's renderer (spec 01 §7.4, SF-05). It is JavaScript, typed by
// web-host.d.mts, only so the type checker accepts a fixed import of a file that P0-D's web-host
// pull request has not landed yet; that pull request may replace it with a plain static import.
// The path is fixed: nothing chooses the renderer at run time.

import { existsSync } from "node:fs";

/** @returns {Promise<unknown>} the renderer module, or undefined while the file does not exist */
export async function importWebHostRenderer() {
  if (!existsSync(new URL("../../../../packages/web-host/src/static/render.ts", import.meta.url))) {
    return undefined;
  }
  return import("../../../../packages/web-host/src/static/render.ts");
}
