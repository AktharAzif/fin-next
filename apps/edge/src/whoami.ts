// GET /v4/whoami, `getApiKey` (spec 05 §6.2, §6.11's ApiKey), answered by the edge (§2.1 step 21):
// the key the request carried, as the check found it. Then, after the answer, "last used" is written
// at most once a minute per key (§2.1 step 23, [BC-05]): the statement runs only when this replica
// has not touched the key this minute (last-used.ts); a failure there never changes the answer, and
// is the `background.failed` line.
import type { FinContext } from "@fin/server/http";
import { type KeyCheckDeps, verifiedKeyOf } from "./keycheck.ts";
import { problemAnswer } from "./problems.ts";

export interface ApiKeyResource {
  object: "api_key";
  id: string;
  livemode: boolean;
  kind: "secret" | "restricted";
  /** `["*"]` for a full-access key. */
  scopes: string[];
  organization: string;
}

export function whoami(c: FinContext, deps: KeyCheckDeps): Response {
  const key = verifiedKeyOf(c);
  if (key === undefined) return problemAnswer(c, deps.docsOrigin, { code: "internal" });
  const body: ApiKeyResource = {
    object: "api_key",
    id: key.id,
    livemode: key.mode === "live",
    kind: key.kind === "sk" ? "secret" : "restricted",
    scopes: key.kind === "sk" ? ["*"] : [...key.scopes],
    organization: key.organizationId,
  };
  const keyId = key.id;
  if (deps.lastUsed.due(keyId)) {
    deps.telemetry.shipAfter(
      new Promise<void>((resolve) => setImmediate(resolve)).then(() => deps.store.touch(keyId)),
      "keys.touch_last_used",
    );
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
