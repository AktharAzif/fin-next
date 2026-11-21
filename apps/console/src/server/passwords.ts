// The handlers of the console's password routes (policy/passwords.ts; spec 02 §5.7). Each runs in
// one unit of work of the developer realm.
import { AuthRefusal, finCookieName, readCookie, resetCodeLink } from "@fin/identity";
import type { Handler } from "./handlers.ts";

export const PASSWORD_HANDLERS = {
  async signInMethods(_input, deps) {
    // Configuration only, the same for every caller: nothing about a person or an address.
    return { status: 200, body: { password: deps.orgs.realm.settings.features.passwords } };
  },

  async resetCodeLink(input, deps) {
    const realm = deps.orgs.realm;
    // With passwords off there is no reset, and the route answers as an unknown one would.
    if (!realm.settings.features.passwords) throw new AuthRefusal("not_found", "policy.off");
    const state = await realm.run(input.context, async (tx, request) => {
      const limit = await realm.runtime.limits.consume(
        tx,
        "code_sign_in",
        realm.runtime.hasher.bucket("network", request.network),
      );
      if (!limit.allowed) {
        throw new AuthRefusal("rate_limited", "limits.code_sign_in", {
          retry_after: limit.retryAfter,
        });
      }
      return resetCodeLink(
        tx,
        { clock: realm.runtime.clock, hasher: realm.runtime.hasher },
        String(input.body.email),
        readCookie(input.request.headers.get("cookie"), finCookieName("developer", "code_browser")),
      );
    });
    return { status: 200, body: { state } };
  },
} satisfies Record<string, Handler>;
