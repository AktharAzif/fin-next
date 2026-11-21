// api-keys/key-changed (spec 05 §4.10; spec 02 §12.3, §17.2): to every member when a key is created,
// edited (a name alone included), rolled or revoked. A security notice, never dropped ([SA-41]): past
// the per-recipient limits it folds into the digest, which is still sent. No key material: the key's
// ID and name only.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { API_KEYS, environmentLabel, keyId, keyName } from "./shared.ts";

const CHANGE = {
  created: { label: "Created", line: "Someone in your team created an API key." },
  edited: { label: "Edited", line: "Someone in your team changed an API key." },
  rolled: {
    label: "Rolled",
    line: "Someone in your team rolled an API key: a new key replaces it, and the old one stops working when its overlap ends.",
  },
  revoked: {
    label: "Revoked",
    line: "Someone in your team revoked an API key. Anything still using it gets 401 errors.",
  },
} as const;

export const keyChanged = defineTemplate({
  name: "key-changed",
  area: "api-keys",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Changes to your team's API keys",
  params: z.strictObject({
    orgId: param.orgId,
    keyId,
    change: z.enum(["created", "edited", "rolled", "revoked"]),
    mode: param.mode,
    orgName: param.orgName,
    keyName: keyName.optional(),
    /** The key that replaces it, after a roll. */
    newKeyId: keyId.optional(),
  }),
  sample: {
    orgId: "org_01jd0000000000000000000000",
    keyId: "K8D2M4P6Q1",
    change: "rolled",
    mode: "sandbox",
    orgName: "Example Payments",
    keyName: "Payout worker",
    newKeyId: "W6N4R3T5V7",
  },
  render: (p) => ({
    subject: "An API key changed in your team on Fin",
    heading: "An API key changed",
    preview: "One of your team's API keys on Fin changed.",
    paragraphs: [CHANGE[p.change].line],
    boxes: [
      { label: "Team", value: p.orgName },
      ...(p.keyName === undefined ? [] : [{ label: "Key", value: p.keyName }]),
      { label: "Key ID", value: p.keyId },
      { label: "Environment", value: environmentLabel(p.mode) },
      { label: "Change", value: CHANGE[p.change].label },
      ...(p.newKeyId === undefined ? [] : [{ label: "New key ID", value: p.newKeyId }]),
    ],
    link: API_KEYS,
    footer: ["If you don't expect this change, check your team's audit log."],
  }),
});
