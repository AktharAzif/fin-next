// Email Sending (spec 01 §7.8): both sending domains exist with preview and drop-suppressed off,
// and the zone's _dmarc record exists.
import { emailNames } from "../settings.ts";
import { type Check, type Failure, records } from "./common.ts";

export const email: Check = {
  name: "email",
  async run(ctx) {
    const failures: Failure[] = [];
    const zoneId = await ctx.zoneId();
    const { domains, dmarc } = emailNames(ctx.settings);
    const subdomains = records(await ctx.cf.list(`/zones/${zoneId}/email/sending/subdomains`));
    for (const [index, domain] of domains.entries()) {
      const target = ctx.settings.email.subdomains[index] ?? "other";
      const add = (detail: string) => failures.push({ check: "email", target, detail });
      const found = subdomains.find((s) => s.name === domain);
      if (found === undefined) {
        add("subdomain_missing");
        continue;
      }
      if (found.preview_enabled !== false) add("preview_enabled");
      if (found.drop_suppressed_recipients !== false) add("drop_suppressed_on");
    }
    const txt = records(
      await ctx.cf.list(`/zones/${zoneId}/dns_records`, { name: dmarc, type: "TXT" }),
    ).filter((r) => r.name === dmarc);
    if (txt.length === 0)
      failures.push({ check: "email", target: "dmarc", detail: "dmarc_missing" });
    else if (
      !txt.some((r) =>
        String(r.content ?? "")
          .replace(/^"/, "")
          .startsWith("v=DMARC1"),
      )
    ) {
      failures.push({ check: "email", target: "dmarc", detail: "dmarc_invalid" });
    }
    return failures;
  },
};
