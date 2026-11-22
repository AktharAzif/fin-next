// The team (spec 02 §9.2 to §9.4, §14.2): members, the "No access" rows, invitations, and the
// changes, each with an intent. The client's reading of §14.2 until L-SAT-03's app-contracts
// fragment carries them; unknown fields are kept.
import { defineContract, z } from "@fin/app-contracts";

export const SECOND_FACTORS = ["passkey", "authenticator", "both", "none"] as const;

export const memberRow = z.looseObject({
  memberId: z.string().min(1),
  userId: z.string().min(1),
  name: z.string(),
  email: z.string(),
  roleKey: z.string(),
  roleLabel: z.string(),
  roleKnown: z.boolean(),
  secondFactor: z.enum(SECOND_FACTORS),
  joinedAt: z.string().min(1),
  isYou: z.boolean(),
});
export type MemberRow = z.output<typeof memberRow>;

export const INVITATION_STATUSES = [
  "pending",
  "expired",
  "declined",
  "accepted",
  "cancelled",
] as const;

export const invitationRow = z.looseObject({
  invitationId: z.string().min(1),
  email: z.string(),
  roleKey: z.string(),
  roleLabel: z.string(),
  roleKnown: z.boolean().optional(),
  status: z.enum(INVITATION_STATUSES),
  expiresAt: z.string().min(1),
  answeredAt: z.string().nullable().optional(),
});
export type InvitationRow = z.output<typeof invitationRow>;

export const team = defineContract({
  name: "team.get",
  method: "GET",
  path: "/team",
  organization: true,
  input: z.object({
    q: z.string().max(200).optional(),
    page: z.number().int().positive().optional(),
    size: z.number().int().positive().max(100).optional(),
  }),
  output: z.looseObject({
    members: z.array(memberRow),
    membersTotal: z.number().int().nonnegative(),
    invitations: z.array(invitationRow),
  }),
});
export type TeamAnswer = z.output<(typeof team)["output"]>;

export const credentialRow = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(["api_key", "webhook_secret"]),
  label: z.string(),
  made: z.boolean(),
  seen: z.boolean(),
  /** Whether this actor's role rolls it at once (S2-42); otherwise it keeps working for the hour. */
  rollsNow: z.boolean().optional(),
});
export type CredentialRow = z.output<typeof credentialRow>;

export const memberCredentials = defineContract({
  name: "team.memberCredentials",
  method: "GET",
  path: "/team/members/:memberId/credentials",
  organization: true,
  input: z.object({ memberId: z.string().min(1) }),
  output: z.looseObject({ items: z.array(credentialRow) }),
});

export const changeMemberRole = defineContract({
  name: "team.changeRole",
  method: "PATCH",
  path: "/team/members/:memberId",
  organization: true,
  input: z.object({
    memberId: z.string().min(1),
    roleKey: z.string().min(1),
    rollCredentials: z.boolean(),
  }),
  output: z.unknown(),
});

export const removeMember = defineContract({
  name: "team.remove",
  method: "POST",
  path: "/team/members/:memberId/remove",
  organization: true,
  input: z.object({ memberId: z.string().min(1), rollCredentials: z.boolean() }),
  output: z.unknown(),
});

export const inviteMember = defineContract({
  name: "team.invite",
  method: "POST",
  path: "/team/invitations",
  organization: true,
  creates: true,
  input: z.object({ email: z.string().trim().min(3).max(254), roleKey: z.string().min(1) }),
  output: z.unknown(),
});

export const changeInvitation = defineContract({
  name: "team.changeInvitation",
  method: "PATCH",
  path: "/team/invitations/:invitationId",
  organization: true,
  input: z.object({ invitationId: z.string().min(1), roleKey: z.string().min(1) }),
  output: z.unknown(),
});

export const resendInvitation = defineContract({
  name: "team.resendInvitation",
  method: "POST",
  path: "/team/invitations/:invitationId/resend",
  organization: true,
  input: z.object({ invitationId: z.string().min(1) }),
  output: z.unknown(),
});

export const cancelInvitation = defineContract({
  name: "team.cancelInvitation",
  method: "DELETE",
  path: "/team/invitations/:invitationId",
  organization: true,
  input: z.object({ invitationId: z.string().min(1) }),
  output: z.unknown(),
});
