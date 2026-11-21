// `/env.json`, the one per-environment file a static build reads (spec 01 §7.4, spec 06 §2.3). The
// build is environment-neutral: the deploy renders this file into each artefact from the
// environment's public settings, and the entry module fetches it in parallel with the viewer
// request. One schema for every app; unknown fields are ignored, so the docs site can add its own.
import { z } from "zod";

export const ENVIRONMENTS = ["development", "ci", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True for a bare origin (`https://host[:port]`, nothing after it). Plain http is allowed only on a
 * loopback host, for development and CI; every deployed origin is https.
 */
export function isOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

const origin = z.string().refine(isOrigin, { message: "an https origin with no path" });

export const envSchema = z.object({
  environment: z.enum(ENVIRONMENTS),
  /** The release's commit, compared with every API answer's `Fin-Release` (FW-C13). */
  release: z.string().min(1).max(64),
  /** Only on the docs site and under the fallback shape (ARCHITECTURE §5.17). */
  apiOrigin: origin.optional(),
  docsOrigin: origin,
  consoleOrigin: origin,
});
export type FinEnv = z.output<typeof envSchema>;

export type EnvResult =
  | { ok: true; env: FinEnv }
  | { ok: false; reason: "network" | "status" | "not_json" | "invalid" };

/**
 * Fetches and checks `/env.json`. Never throws: the frame shows its error state ("Couldn't load
 * Fin" with Try again) for any failure, and renders nothing else (spec 06 §2.3).
 */
export async function loadEnv(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<EnvResult> {
  let response: Response;
  try {
    response = await fetchImpl("/env.json", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-cache",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (!response.ok) return { ok: false, reason: "status" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const parsed = envSchema.safeParse(body);
  return parsed.success ? { ok: true, env: parsed.data } : { ok: false, reason: "invalid" };
}
