// Invitations from the invitee's side (spec 02 §9.3, §14.2): open a link's token (which sets the
// invitation cookie), read the invitation in the cookie, accept or decline it. The token never
// leaves the page except in `open`'s body. The client's reading of §14.2 until L-SAT-03's
// app-contracts fragment carries them.
import { defineContract, noInput, z } from "@fin/app-contracts";

export const INVITATION_STATES = ["for_you", "other_account", "signed_out"] as const;

export const invitationView = z.looseObject({
  invitationId: z.string().min(1),
  orgName: z.string(),
  inviterName: z.string(),
  inviterEmail: z.string(),
  roleLabel: z.string(),
  /** The invited address, masked (`a•••@example.com`). */
  emailMasked: z.string(),
  /** The invited address in full, only when it is the signed-in person's own. */
  email: z.string().nullable().optional(),
  /** The signed-in person's address, when someone else is signed in. */
  signedInEmail: z.string().nullable().optional(),
  expiresAt: z.string().min(1),
  state: z.enum(INVITATION_STATES),
});
export type InvitationView = z.output<typeof invitationView>;

export const openInvitation = defineContract({
  name: "invitations.open",
  method: "POST",
  path: "/invitations/open",
  input: z.object({ token: z.string().min(16).max(256) }),
  output: invitationView,
});

/** The invitation in the cookie; none waiting is `404 invitation_unusable`, or an empty answer. */
export const waitingInvitation = defineContract({
  name: "invitations.waiting",
  method: "GET",
  path: "/invitation",
  input: noInput,
  output: invitationView.nullable(),
});

export const acceptInvitation = defineContract({
  name: "invitations.accept",
  method: "POST",
  path: "/invitations/:invitationId/accept",
  input: z.object({ invitationId: z.string().min(1) }),
  output: z.unknown(),
});

export const declineInvitation = defineContract({
  name: "invitations.decline",
  method: "POST",
  path: "/invitations/:invitationId/decline",
  input: z.object({ invitationId: z.string().min(1) }),
  output: z.unknown(),
});
