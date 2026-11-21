// What the API keys page derives from the answers (the ApiKeys, ApiKeyCreate and ApiKeyActions
// boards): each status's badge and line, the access text, the scope list in its order, the
// allowlist as typed, the form's checks before it is sent (the server checks every one again), and
// what a field refusal says. Pure, so the unit tests read it.
import type { StatusTone } from "@fin/ui";
import { formatDay } from "../../../format/dates.ts";
import type { KeyRow } from "./-api.ts";

export const SCOPE_ORDER = [
  "customers:read",
  "customers:write",
  "events:read",
  "money:read",
  "money:write",
  "beneficiaries:write",
  "sandbox:simulate",
  "sandbox:deposit",
] as const;

export const SANDBOX_ONLY = new Set<string>(["sandbox:simulate", "sandbox:deposit"]);

export const STATUS: Readonly<Record<KeyRow["status"], { label: string; tone: StatusTone }>> = {
  active: { label: "Active", tone: "success" },
  rolling: { label: "Rolling, still valid", tone: "warning" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "neutral" },
};

/** The line under a key's status badge. */
export function statusLine(key: KeyRow): string {
  switch (key.status) {
    case "revoked":
      return `Revoked ${formatDay(key.revokedAt)}`;
    case "rolling":
      return `Works until ${formatDay(key.rollingUntil)}, when the overlap ends`;
    case "expired":
      return key.replacedBy === null
        ? `Expired ${formatDay(key.expiresAt)}`
        : "Replaced by a rolled key";
    default:
      return key.expiresAt === null ? "Expires never" : `Expires ${formatDay(key.expiresAt)}`;
  }
}

export function lastUsedLine(key: KeyRow): string {
  return key.lastUsedAt === null ? "Never used" : `Last used ${formatDay(key.lastUsedAt)}`;
}

/** Keys per page of a mode's list (the server's largest page). */
export const KEYS_PAGE_SIZE = 100;

/** How many pages a mode's list has, at least one. */
export function pageCountOf(total: number, size = KEYS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/** What a role may make in one mode, as `GET /api/keys` answers it (`can.test`, `can.live`). */
export interface ModeAbilities {
  manage: boolean;
  fullAccess: boolean;
  scopes: readonly string[];
}

/**
 * Whether the role holds everything a key of this kind and these scopes can do, which an allowlist
 * change asks of the editor, as rolling does (the server checks it again).
 */
export function withinRole(
  abilities: ModeAbilities | undefined,
  kind: KeyRow["kind"],
  scopes: readonly string[],
): boolean {
  if (abilities === undefined || !abilities.manage) return false;
  return kind === "sk" ? abilities.fullAccess : scopes.every((s) => abilities.scopes.includes(s));
}

export function environmentLabel(mode: KeyRow["mode"]): string {
  return mode === "live" ? "Production" : "Sandbox";
}

/** The allowlist as typed: entries separated by commas, spaces or new lines. */
export function parseAllowlist(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export type ExpiryChoice = "30d" | "90d" | "1y" | "never";

export const EXPIRY_LABELS: Readonly<Record<ExpiryChoice, string>> = {
  "90d": "In 90 days",
  "30d": "In 30 days",
  "1y": "In 1 year",
  never: "Never",
};

export interface CreateDraft {
  name: string;
  mode: "test" | "live";
  kind: "sk" | "rk";
  scopes: string[];
  allowlist: string;
  expiresIn: ExpiryChoice;
}

export interface DraftProblems {
  name?: string;
  scopes?: string;
  allowlist?: string;
}

const NAME_SENTENCE = "Give the key a name of up to 60 characters.";
const NAME_RULE =
  "A key’s name appears in emails, so it can’t look like a web or email address. Use a dash instead of a dot, such as payments-prod.";

/** The form's own checks; the server refuses the same, and more, regardless. */
export function draftProblems(draft: CreateDraft): DraftProblems {
  const out: DraftProblems = {};
  const name = draft.name.trim();
  if (name === "" || Array.from(name).length > 60) out.name = NAME_SENTENCE;
  else if (/[\p{L}\p{Nd}]\.[\p{L}\p{Nd}]|@|https?:\/\/|www\./iu.test(name)) out.name = NAME_RULE;
  if (draft.kind === "rk" && draft.scopes.length === 0) {
    out.scopes = "Pick at least one scope, or choose Full access.";
  }
  if (parseAllowlist(draft.allowlist).length > 20) out.allowlist = "Up to 20 addresses or ranges.";
  return out;
}

/** What a field refusal from the server says, by its path and code. */
export function fieldSentence(
  path: string,
  code: string,
): { field: keyof DraftProblems; text: string } {
  if (path === "name")
    return { field: "name", text: code === "web_address" ? NAME_RULE : NAME_SENTENCE };
  if (path === "scopes") return { field: "scopes", text: "Pick scopes your role allows." };
  if (path.startsWith("ipAllowlist")) {
    const index = Number(path.split(".")[1]);
    const which = Number.isInteger(index) ? `Entry ${index + 1}` : "The allowlist";
    const why =
      code === "required_for_money"
        ? "A Production key that moves money needs an address allowlist."
        : code === "too_wide"
          ? `${which} is too wide: use /16 or narrower for IPv4, /32 or narrower for IPv6.`
          : code === "unparsable"
            ? `${which} isn’t an IPv4 or IPv6 address or range.`
            : `${which} is a range no request can come from.`;
    return { field: "allowlist", text: why };
  }
  return { field: "name", text: "Check what you entered." };
}

/** `export FIN_KEY=…`, for the secret's "Copy as FIN_KEY=…". */
export function envLine(secret: string): string {
  return `FIN_KEY=${secret}`;
}
