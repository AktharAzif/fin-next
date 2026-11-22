// Account security's calls (spec 02 §14.2, person scope): the summary, the paged lists of passkeys,
// sessions and recent activity, and the changes with their step-ups (name with a window, the rest
// with intents, §7.6). The client's reading of §14.2 until L-SAT-02's app-contracts fragment
// carries them; unknown fields are kept.
import { defineContract, noInput, z } from "@fin/app-contracts";
import { auditRow } from "./audit.ts";

const iso = z.string().min(1);

export const passkeyRow = z.looseObject({
  id: z.string().min(1),
  /** Fin's device summary ("Chrome on Mac"), set when it was added (spec 02 §5.3). */
  name: z.string(),
  createdAt: iso,
  lastUsedAt: iso.nullable().optional(),
});
export type PasskeyRow = z.output<typeof passkeyRow>;

export const trustedBrowserRow = z.looseObject({
  id: z.string().min(1),
  device: z.string(),
  createdAt: iso,
  expiresAt: iso,
});
export type TrustedBrowserRow = z.output<typeof trustedBrowserRow>;

export const accountSecurity = defineContract({
  name: "account.security",
  method: "GET",
  path: "/account/security",
  input: noInput,
  output: z.looseObject({
    name: z.string(),
    email: z.string(),
    passkeys: z.array(passkeyRow),
    authenticator: z.boolean(),
    backupCodesLeft: z.number().int().nonnegative().nullable(),
    trustedBrowsers: z.array(trustedBrowserRow).default([]),
    /** The no-second-factor warning (the board's `noSecondFactor`). */
    noSecondFactor: z.boolean(),
  }),
});
export type AccountSecurity = z.output<(typeof accountSecurity)["output"]>;

const paging = z.object({
  page: z.number().int().positive().optional(),
  size: z.number().int().positive().max(100).optional(),
});

export const sessionRow = z.looseObject({
  id: z.string().min(1),
  device: z.string(),
  ipAddress: z.string().nullable(),
  createdAt: iso,
  lastSeenAt: iso,
  current: z.boolean(),
});
export type SessionRow = z.output<typeof sessionRow>;

export const accountSessions = defineContract({
  name: "account.sessions",
  method: "GET",
  path: "/account/sessions",
  input: paging,
  output: z.looseObject({ items: z.array(sessionRow), total: z.number().int().nonnegative() }),
});

export const accountActivity = defineContract({
  name: "account.activity",
  method: "GET",
  path: "/account/activity",
  input: paging,
  output: z.looseObject({ items: z.array(auditRow), total: z.number().int().nonnegative() }),
});

export const renameSelf = defineContract({
  name: "account.rename",
  method: "PATCH",
  path: "/account/name",
  input: z.object({ name: z.string().max(200) }),
  output: z.unknown(),
});

export const revokeSession = defineContract({
  name: "account.revokeSession",
  method: "POST",
  path: "/account/sessions/:sessionId/revoke",
  input: z.object({ sessionId: z.string().min(1) }),
  output: z.unknown(),
});

export const revokeOtherSessions = defineContract({
  name: "account.revokeOtherSessions",
  method: "POST",
  path: "/account/sessions/revoke-others",
  input: noInput,
  output: z.looseObject({ revoked: z.number().int().nonnegative() }),
});

export const forgetTrustedBrowser = defineContract({
  name: "account.forgetTrustedBrowser",
  method: "DELETE",
  path: "/account/trusted-browsers/:browserId",
  input: z.object({ browserId: z.string().min(1) }),
  output: z.unknown(),
});
