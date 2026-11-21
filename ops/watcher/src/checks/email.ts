// Email Sending (spec 01 §7.8, §7.11): both sending domains exist with preview and drop-suppressed
// off, and each has its own DMARC record, `_dmarc.<label>.<zone>`, at the settings' policy or
// stronger (BD-17: p=reject). The zone's apex `_dmarc` belongs to the old product (FD-09) and is
// never read: its changes are not fin-next's, and it cannot stand in for fin-next's records.
import { type DmarcPolicy, emailNames } from "../settings.ts";
import { type Check, type Failure, records } from "./common.ts";

const STRENGTH: Readonly<Record<string, number>> = { none: 0, quarantine: 1, reject: 2 };

/** A TXT record's text: the quoted strings joined (Cloudflare returns them quoted). */
export function txtText(content: unknown): string {
  const raw = String(content ?? "").trim();
  if (!raw.startsWith('"')) return raw;
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "").join("");
}

/** Whether a TXT record's text is a DMARC record: it starts `v=DMARC1`, exactly (RFC 7489 §6.4). */
export function isDmarc(text: string): boolean {
  return /^[vV]\s*=\s*DMARC1\s*(?:;|$)/.test(text.trim());
}

const TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A DMARC record's tags (RFC 7489 §6.3, §6.4), names lowercased, or undefined when it is not a
 * DMARC record or not a valid tag list. Receivers differ on a malformed record (one discards it,
 * another reads its first `p`, another its last), so the check never judges one: `v=DMARC1` is
 * the first tag, `p` (when present) the tag right after it, every tag is `name=value`, and no tag
 * occurs twice (RFC 6376 §3.2, whose tag lists DMARC uses: a repeated tag invalidates the list).
 */
export function dmarcTags(text: string): Map<string, string> | undefined {
  if (!isDmarc(text)) return undefined;
  const parts = text.trim().split(";");
  // One trailing separator is allowed; an empty tag anywhere else is not.
  if (parts.length > 1 && (parts.at(-1) ?? "").trim() === "") parts.pop();
  const tags = new Map<string, string>();
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at < 0) return undefined;
    const name = part.slice(0, at).trim();
    if (!TAG_NAME.test(name) || tags.has(name.toLowerCase())) return undefined;
    tags.set(name.toLowerCase(), part.slice(at + 1).trim());
  }
  const names = [...tags.keys()];
  if (names[0] !== "v" || tags.get("v") !== "DMARC1") return undefined;
  if (tags.has("p") && names[1] !== "p") return undefined;
  return tags;
}

/** Why a DMARC record is weaker than `required`, or undefined when it is not. */
export function dmarcWeakness(
  tags: Map<string, string>,
  required: DmarcPolicy,
): string | undefined {
  const floor = STRENGTH[required] ?? 2;
  const policy = STRENGTH[(tags.get("p") ?? "").toLowerCase()];
  if (policy === undefined || policy < floor) return "p";
  const sp = tags.get("sp");
  if (sp !== undefined && (STRENGTH[sp.toLowerCase()] ?? -1) < floor) return "sp";
  const pct = tags.get("pct");
  if (pct !== undefined && pct !== "100") return "pct";
  return undefined;
}

export const email: Check = {
  name: "email",
  async run(ctx) {
    const failures: Failure[] = [];
    const zoneId = await ctx.zoneId();
    const names = emailNames(ctx.settings);
    const subdomains = records(await ctx.cf.list(`/zones/${zoneId}/email/sending/subdomains`));
    for (const { label, domain } of names) {
      const add = (detail: string) => failures.push({ check: "email", target: label, detail });
      const found = subdomains.find((s) => s.name === domain);
      if (found === undefined) {
        add("subdomain_missing");
        continue;
      }
      if (found.preview_enabled !== false) add("preview_enabled");
      if (found.drop_suppressed_recipients !== false) add("drop_suppressed_on");
    }
    for (const { label, dmarc } of names) {
      // Its own target, so a standing setting failure on the domain never hides a DMARC change.
      const add = (detail: string) =>
        failures.push({ check: "email", target: `_dmarc.${label}`, detail });
      const texts = records(
        await ctx.cf.list(`/zones/${zoneId}/dns_records`, { name: dmarc, type: "TXT" }),
      )
        .filter((r) => r.name === dmarc && r.type === "TXT")
        .map((r) => txtText(r.content));
      // Receivers ignore DMARC when a name holds more than one record (RFC 7489 §6.6.3).
      const dmarcRecords = texts.filter(isDmarc);
      if (texts.length === 0) add("dmarc_missing");
      else if (dmarcRecords.length === 0) add("dmarc_invalid");
      else if (dmarcRecords.length > 1) add("dmarc_duplicate");
      else {
        const tags = dmarcTags(dmarcRecords[0] ?? "");
        if (tags === undefined) add("dmarc_invalid");
        else if (dmarcWeakness(tags, ctx.settings.email.dmarcPolicy) !== undefined) {
          add("dmarc_weak");
        }
      }
    }
    return failures;
  },
};
