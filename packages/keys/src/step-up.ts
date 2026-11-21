// The API keys area's step-up actions (spec 02 §7.6, §12.3; [SA-34]; IF-03): every key change takes an
// intent bound to the action, the organisation, the key and the fields listed in `bind`, so an intent
// proved for one change can never be spent on another. Spec 02 §7.6 places the fragment at
// packages/identity/src/step-up/actions/keys.ts; this lane owns packages/keys/**, so it lives here and
// the console hands it to createRealm({ actions }), which refuses a key listed twice. The reason
// keys are spec 02 §15.5's ("Use your second factor to create an API key.").
//
// Written in the realm's StepUpAction shape without importing packages/identity: a plain readonly
// list the console passes in, type-checked there.
export const KEYS_ACTIONS = [
  {
    key: "key.create",
    realm: "developer",
    kind: "intent",
    reasonKey: "key.create",
    bind: [
      { name: "name", kind: "string" },
      { name: "mode", kind: "string" },
      { name: "kind", kind: "string" },
      { name: "scopes", kind: "keys" },
      { name: "ipAllowlist", kind: "keys" },
      { name: "expiresIn", kind: "string" },
    ],
  },
  {
    key: "key.update",
    realm: "developer",
    kind: "intent",
    reasonKey: "key.update",
    bind: [
      { name: "name", kind: "string" },
      { name: "scopes", kind: "keys" },
      { name: "expiresAt", kind: "string" },
      { name: "ipAllowlist", kind: "keys" },
    ],
  },
  {
    key: "key.roll",
    realm: "developer",
    kind: "intent",
    reasonKey: "key.roll",
    bind: [{ name: "overlap", kind: "string" }],
  },
  {
    key: "key.revoke",
    realm: "developer",
    kind: "intent",
    reasonKey: "key.revoke",
    bind: [],
  },
] as const;

export type KeysActionKey = (typeof KEYS_ACTIONS)[number]["key"];
