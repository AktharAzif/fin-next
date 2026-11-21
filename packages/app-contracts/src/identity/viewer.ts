// The console's viewer (spec 02 §14.4). `GET /api/viewer` answers `401 unauthenticated` with no
// session; with one, it says which gate the person is at and, once past it, who they are, their
// memberships and their permissions in the current organisation. The entry module starts this
// request in parallel with `/env.json` and decides the first navigation from it (spec 06 §2.3).
//
// P0-G's stub of the contract: spec 02's identity lane owns this file once it merges (spec 06
// §11.3) and adds the contract test against the route.

import { defineContract, noContent, noInput } from "../contract.ts";
import { STEP_UP_METHODS } from "../problem.ts";
import { z } from "../zod.ts";

export const consoleMembership = z.object({
  orgId: z.string().min(1),
  name: z.string(),
  roleKey: z.string().min(1),
  roleLabel: z.string(),
  roleKnown: z.boolean(),
  liveStatus: z.string(),
});
export type ConsoleMembership = z.output<typeof consoleMembership>;

export const consoleViewerFactorStep = z.object({
  gate: z.literal("factor_step"),
  email: z.string(),
  methods: z.array(z.enum(STEP_UP_METHODS)),
});

export const consoleViewerSignedIn = z.object({
  gate: z.enum(["ok", "protect_account"]),
  user: z.object({ id: z.string().min(1), name: z.string(), email: z.string() }),
  assurance: z.enum(["aal1", "aal2"]),
  factors: z.object({
    passkeys: z.number().int().nonnegative(),
    authenticator: z.boolean(),
    backupCodesLeft: z.number().int().nonnegative().nullable(),
  }),
  canSkipProtect: z.boolean(),
  canTrustBrowser: z.boolean(),
  memberships: z.array(consoleMembership),
  /** `null`: no membership yet (spec 02 §5.9), or every role unknown (NoAccess). */
  currentOrgId: z.string().min(1).nullable(),
  /** The permissions in the current organisation. */
  permissions: z.array(z.string()),
  invitations: z.array(
    z.object({
      invitationId: z.string().min(1),
      orgName: z.string(),
      roleLabel: z.string(),
      expiresAt: z.string(),
    }),
  ),
});

export const consoleViewerAnswer = z.union([consoleViewerFactorStep, consoleViewerSignedIn]);
export type ConsoleViewer = z.output<typeof consoleViewerAnswer>;
export type ConsoleViewerSignedIn = z.output<typeof consoleViewerSignedIn>;

export const consoleViewer = defineContract({
  name: "viewer.get",
  method: "GET",
  path: "/viewer",
  input: noInput,
  output: consoleViewerAnswer,
});

/** Choosing another organisation in the header's switcher (spec 06 §4.3). */
export const setCurrentOrganization = defineContract({
  name: "viewer.setOrganization",
  method: "PUT",
  path: "/viewer/organization",
  input: z.object({ orgId: z.string().min(1) }),
  output: noContent,
});
