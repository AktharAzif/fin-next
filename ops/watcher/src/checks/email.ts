// Email Sending (spec 01 §7.8, §7.11): both sending domains exist with preview and drop-suppressed
// off, and each has its own DMARC record, `_dmarc.<label>.<zone>`, at the settings' policy or
// stronger (BD-17: p=reject). The zone's apex `_dmarc` belongs to the old product (FD-09) and is
// never read: its changes are not fin-next's, and it cannot stand in for fin-next's records.
import { type DmarcPolicy, emailNames } from "../settings.ts";
import { type Check, type Failure, records } from "./common.ts";

const STRENGTH: Readonly<Record<string, number>> = { none: 0, quarantine: 1, reject: 2 };

// DMARC's grammar (RFC 7489 §6.4, kept by RFC 9989) knows only space and tab as white space
// (WSP). JavaScript's trim() and `\s` also take a no-break space, a byte-order mark, an
// ideographic space, a vertical tab and more, which receivers read as part of a tag or as a
// record that is not DMARC at all; so the parse below never uses them (`[\s\S]` below is only
// "any character").
const trimWsp = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, "");

/** The quoted strings of a zone file's TXT record, white space between them and nothing else. */
const QUOTED = /^[ \t]*(?:"(?:[^"\\]|\\[\s\S])*"[ \t]*)+$/;

/** A zone file's escapes: `\DDD` is one byte (as one character), `\X` is X. */
const readEscapes = (text: string) =>
  text.replace(/\\(\d{3}|[\s\S])/g, (_, e: string) =>
    e.length === 3 ? String.fromCharCode(Number(e)) : e,
  );

/**
 * A TXT record's text: the quoted strings joined, their escapes read (Cloudflare returns them
 * quoted), or the content as it is when it is not quoted. Content that starts quoted but holds
 * anything besides quoted strings is returned as it is, so it reads as no DMARC record.
 */
export function txtText(content: unknown): string {
  const raw = String(content ?? "");
  if (!/^[ \t]*"/.test(raw) || !QUOTED.test(raw)) return raw;
  return [...raw.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)]
    .map((m) => readEscapes(m[1] ?? ""))
    .join("");
}

/**
 * Whether a TXT record's text is a DMARC record: it starts with `v`, optional WSP, `=`, optional
 * WSP and `DMARC1`, exactly (RFC 7489 §6.4); a record that does not is discarded by receivers.
 */
export function isDmarc(text: string): boolean {
  return /^[vV][ \t]*=[ \t]*DMARC1[ \t]*(?:;|$)/.test(text);
}

const TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Anything but printable ASCII, space and tab: no DMARC tag or value holds it. */
const OUTSIDE_GRAMMAR = /[^\x20-\x7e\t]/;

/**
 * A DMARC record's tags (RFC 7489 §6.3, §6.4), names lowercased, or undefined when it is not a
 * DMARC record or not a valid tag list. Receivers differ on a malformed record (one discards it,
 * another reads its first `p`, another its last), so the check never judges one: `v=DMARC1` is
 * the first tag, `p` (when present) the tag right after it, every tag is `name=value`, no tag
 * occurs twice (RFC 6376 §3.2, whose tag lists DMARC uses: a repeated tag invalidates the list),
 * and the record holds only printable ASCII, space and tab.
 */
export function dmarcTags(text: string): Map<string, string> | undefined {
  if (!isDmarc(text) || OUTSIDE_GRAMMAR.test(text)) return undefined;
  const parts = text.split(";");
  // One trailing separator is allowed; an empty tag anywhere else is not.
  if (parts.length > 1 && trimWsp(parts.at(-1) ?? "") === "") parts.pop();
  const tags = new Map<string, string>();
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at < 0) return undefined;
    const name = trimWsp(part.slice(0, at));
    if (!TAG_NAME.test(name) || tags.has(name.toLowerCase())) return undefined;
    tags.set(name.toLowerCase(), trimWsp(part.slice(at + 1)));
  }
  const names = [...tags.keys()];
  if (names[0] !== "v" || tags.get("v") !== "DMARC1") return undefined;
  if (tags.has("p") && names[1] !== "p") return undefined;
  return tags;
}

/**
 * Why a DMARC record is weaker than `required`, or undefined when it is not: a lower or missing
 * `p`, a lower `sp` or `np` (RFC 9989's policy for subdomains that do not exist), a `pct` under
 * 100 (RFC 7489, which receivers still read), or a `t` other than `n` (RFC 9989's test mode, under
 * which a receiver applies `p=reject` as quarantine).
 */
export function dmarcWeakness(
  tags: Map<string, string>,
  required: DmarcPolicy,
): string | undefined {
  const floor = STRENGTH[required] ?? 2;
  const policy = STRENGTH[(tags.get("p") ?? "").toLowerCase()];
  if (policy === undefined || policy < floor) return "p";
  for (const tag of ["sp", "np"]) {
    const value = tags.get(tag);
    if (value !== undefined && (STRENGTH[value.toLowerCase()] ?? -1) < floor) return tag;
  }
  const pct = tags.get("pct");
  if (pct !== undefined && pct !== "100") return "pct";
  const test = tags.get("t");
  if (test !== undefined && test.toLowerCase() !== "n") return "t";
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
