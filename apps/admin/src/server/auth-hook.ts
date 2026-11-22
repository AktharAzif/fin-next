// The staff realm behind the shared host's step 7 (spec 02 §2.2, §4.3): `/api/auth/*` reaches Better
// Auth only through the realm's exact endpoint allowlist, classified on the raw path before any
// limit is counted; the realm then runs the staff gate, the Access check against the session
// (§10.5) and its own limits in one unit of work, with the front door's facts as its context.
import type { Realm } from "@fin/identity";
import type { AuthClass, AuthHook } from "@fin/web-host";
import { requestContextOf } from "./routes/register.ts";

export function staffAuthHook(realm: Realm): AuthHook {
  return {
    realm: "staff",
    classify(method: string, rawPath: string): AuthClass {
      if (method !== "GET" && method !== "POST") return "unlisted";
      const rule = realm.policy.match(rawPath, method);
      if (rule === null) return "unlisted";
      return rule.class === "blocked" ? "blocked" : "allow";
    },
    async handle(c) {
      const context = requestContextOf(c);
      const response = await realm.handler(c.req.raw, {
        ...context,
        annotate: (fields) => {
          // The realm's own outcome and bounded reason go on the host's one `request` line.
          if (typeof fields.outcome === "string") {
            c.set("outcome", fields.outcome as "ok" | "refused" | "error");
          }
          if (typeof fields.reason === "string") c.set("reason", fields.reason);
          if (fields.staffId !== undefined) c.set("actor", "staff");
        },
      });
      return response;
    },
  };
}
