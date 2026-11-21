// The contract between `pnpm fin static render` and the renderer in packages/web-host/src/static/
// (P0-D's, a control path, [SA-45]; spec 01 §7.4, SF-05). The renderer owns the header profiles and
// the env.json schema; this command owns reading the artefacts, the environment's hostnames and the
// checks on the result. Until packages/web-host/src/static/render.ts exists the command refuses:
// there is no fallback renderer, because a hand-written `_headers` would be exactly the drift the
// header-matrix test exists to stop.
//
// The module must export:
//
//   renderStatic(input: RenderInput): RenderOutput
//
// and is loaded by a fixed relative path (web-host.mjs), never from a setting or a variable.

import type { HostRole } from "../core/overlay.ts";
import type { HeaderProfile } from "../core/settings.ts";
import { importWebHostRenderer } from "./web-host.mjs";

export interface RenderInput {
  /** The deployment key: console, admin, verify, selfie or docs. */
  output: string;
  /** The app the output was built from (verify builds both verify and selfie). */
  app: string;
  profile: HeaderProfile;
  environment: "staging" | "production";
  release: string;
  /**
   * The environment's hostnames by role, for the origins the files name. The admin host appears
   * only in the admin output's input, so no public file can name Fin Admin's origin.
   */
  hosts: Readonly<Partial<Record<HostRole, string>>>;
  /** Whether search engines may index the pages (`X-Robots-Tag` outside production). */
  indexable: boolean;
}

export interface RenderOutput {
  /** The `_headers` file. */
  headers: string;
  /** The `env.json` object (`{ environment, release, apiOrigin?, docsOrigin, consoleOrigin }`). */
  env: Record<string, unknown>;
}

export interface StaticRenderer {
  renderStatic(input: RenderInput): RenderOutput;
}

export type RendererLoader = () => Promise<StaticRenderer | undefined>;

function isRenderer(value: unknown): value is StaticRenderer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StaticRenderer).renderStatic === "function"
  );
}

/** Loads packages/web-host's renderer; undefined while that file does not exist yet. */
export const loadWebHostRenderer: RendererLoader = async () => {
  const mod = await importWebHostRenderer();
  if (mod === undefined) return undefined;
  if (!isRenderer(mod)) {
    throw new Error("packages/web-host/src/static/render.ts does not export renderStatic");
  }
  return mod;
};
