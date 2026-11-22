// The contract between `pnpm fin static render` and the renderer in packages/web-host/src/static/
// (P0-D's, a control path, [SA-45]; spec 01 §7.4, SF-05). The renderer owns the header profiles and
// the env.json schema, and the bytes of both files; this command owns reading the artefacts, the
// environment's hostnames and the checks on the result. Until packages/web-host/src/static/render.ts
// exists the command refuses: there is no fallback renderer, because a hand-written `_headers` would
// be exactly the drift the header-matrix test exists to stop.
//
// The module exports `renderStatic(input: WebHostRenderInput): Rendered` (its own types, imported
// here as types only, so the type checker holds both sides to one contract), and is loaded by a
// fixed relative path (web-host.mjs), never from a setting or a variable. loadWebHostRenderer
// adapts this command's input to it.

import type {
  Rendered,
  StaticEnvironment,
  RenderInput as WebHostRenderInput,
} from "../../../../packages/web-host/src/static/render.ts";
import { ConfigError } from "../core/errors.ts";
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

/**
 * What the renderer answers: packages/web-host's own `Rendered`, the `_headers` file and the
 * `env.json` file (`{ environment, release, docsOrigin, consoleOrigin, apiOrigin? }`) as the bytes
 * it renders, which `static render` writes as they are.
 */
export type RenderOutput = Rendered;

export interface StaticRenderer {
  renderStatic(input: RenderInput): RenderOutput;
}

export type RendererLoader = () => Promise<StaticRenderer | undefined>;

interface WebHostRenderer {
  renderStatic(input: WebHostRenderInput): Rendered;
}

function isRenderer(value: unknown): value is WebHostRenderer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WebHostRenderer).renderStatic === "function"
  );
}

/**
 * This command's input as packages/web-host's renderer takes it: the output (which it checks is
 * one it knows), the environment, the release and the hosts this output may name. The profile is
 * the renderer's own (OUTPUT_PROFILE), and it never lets a non-production page be indexed.
 */
export function webHostInput(input: RenderInput): WebHostRenderInput {
  const hosts: Record<string, string> = {};
  for (const [role, host] of Object.entries(input.hosts)) {
    if (host !== undefined) hosts[role] = host;
  }
  const environment: StaticEnvironment = input.environment;
  return {
    output: input.output as WebHostRenderInput["output"],
    environment,
    release: input.release,
    hosts,
  };
}

/** Loads packages/web-host's renderer; undefined while that file does not exist yet. */
export const loadWebHostRenderer: RendererLoader = async () => {
  const mod = await importWebHostRenderer();
  if (mod === undefined) return undefined;
  if (!isRenderer(mod)) {
    throw new Error("packages/web-host/src/static/render.ts does not export renderStatic");
  }
  return {
    renderStatic(input) {
      try {
        return mod.renderStatic(webHostInput(input));
      } catch (error) {
        // The renderer refuses an input it cannot render (an unknown output, a missing host).
        const why = error instanceof Error ? error.message : "it refused the input";
        throw new ConfigError(`static ${input.output}: the renderer refused: ${why}`);
      }
    },
  };
};
