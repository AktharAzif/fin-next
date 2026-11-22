// The hosts the Cloudflare email adapter may call (spec 08 §2.1, rule 5: `threat-model:check` reads
// this list into the threat model's `providerHosts`).
export const HOSTS: readonly string[] = Object.freeze(["api.cloudflare.com"]);

export const API_ORIGIN = "https://api.cloudflare.com";
