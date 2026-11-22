// api-keys/key-exposed (spec 05 §4.8, §4.10; spec 02 §17.2): to the Super admins and Admins when a
// key was sent over plain http or reported by GitHub's secret scanning. Says what happened and
// whether the key was revoked; no key material. Queued by `api` (fin_api's named template).
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { API_KEYS, environmentLabel, keyId } from "./shared.ts";

const SOURCE = {
  plain_http:
    "A request carried one of your team's API keys over plain http, so it crossed the network unencrypted.",
  secret_scanning: "GitHub reported one of your team's API keys in public code.",
} as const;

export const keyExposed = defineTemplate({
  name: "key-exposed",
  area: "api-keys",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "API keys that were exposed",
  params: z.strictObject({
    orgId: param.orgId,
    keyId,
    mode: param.mode,
    source: z.enum(["plain_http", "secret_scanning"]),
    revoked: z.boolean(),
    orgName: param.orgName,
  }),
  sample: {
    orgId: "org_01jd0000000000000000000000",
    keyId: "K8D2M4P6Q1",
    mode: "live",
    source: "plain_http",
    revoked: true,
    orgName: "Example Payments",
  },
  render: (p) => ({
    subject: "An API key of your team on Fin was exposed",
    heading: "An API key was exposed",
    preview: "One of your team's API keys on Fin may be known to someone else.",
    paragraphs: [
      SOURCE[p.source],
      p.revoked
        ? "Fin revoked the key, so it no longer works. Create a new one and deploy it."
        : "It is a Sandbox key, so Fin did not revoke it. Roll it and deploy the new key.",
    ],
    boxes: [
      { label: "Team", value: p.orgName },
      { label: "Key ID", value: p.keyId },
      { label: "Environment", value: environmentLabel(p.mode) },
      { label: "Revoked", value: p.revoked ? "Yes" : "No" },
    ],
    link: API_KEYS,
    footer: ["Keep keys in a secret store and send them only over https."],
  }),
});
