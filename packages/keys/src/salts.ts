// The per-deployment checksum salts (spec 05 §4.1, [SA-18]). They are public, not secret: a salt
// lets a deployment's docs panel and edge refuse another deployment's key before any lookup, and a
// mistyped key before any work. A salt changes only by appending a new one (`fin-prod-2`) and
// re-issuing keys; every salt ever used stays in KNOWN_SALTS, so a leaked key of any of them is
// still recognised. Browser-safe: this file imports nothing.

export type KeyEnvironment = "development" | "ci" | "staging" | "production";

/** The salt each environment's keys carry today. */
export const SALTS: Readonly<Record<KeyEnvironment, string>> = Object.freeze({
  development: "fin-dev-1",
  ci: "fin-ci-1",
  staging: "fin-stg-1",
  production: "fin-prod-1",
});

/** Every salt ever used, newest last; never shortened. */
export const KNOWN_SALTS: readonly string[] = Object.freeze([
  "fin-dev-1",
  "fin-ci-1",
  "fin-stg-1",
  "fin-prod-1",
]);

/** The salt an environment's deployment must be configured with (`FIN_KEY_SALT`). */
export function saltFor(environment: KeyEnvironment): string {
  return SALTS[environment];
}
