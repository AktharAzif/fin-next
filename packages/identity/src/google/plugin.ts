// Puts Fin's Google provider where the library's social routes look for providers
// (`context.socialProviders`) without mounting a route of its own: `/sign-in/social`,
// `/link-social`, `/unlink-account` and `/callback/:id` are the library's, behind the allowlist
// (§4.2), so the router's path set (T-SAT-01) is the same with Google on or off. The library's own
// `socialProviders.google` option is not used: its provider sends no nonce and does not verify the
// ID token it is handed (provider.ts).
import type { BetterAuthPlugin } from "better-auth";

export const FIN_GOOGLE_PLUGIN_ID = "fin-google";

export function finGooglePlugin(provider: Record<string, unknown>): BetterAuthPlugin {
  return {
    id: FIN_GOOGLE_PLUGIN_ID,
    init: () => ({ context: { socialProviders: [provider] } }),
  } as unknown as BetterAuthPlugin;
}
