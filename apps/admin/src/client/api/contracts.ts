// Fin Admin's own JSON routes under `admin.<zone>/api/` that the Saturday screens call (spec 02
// §14.3, §10.2): staff, the staff roles, the enrolment code and the member's own sign-in. Every one
// goes through @fin/frame's api(), so it is same-origin, carries `X-Fin-App: admin` when unsafe,
// sends JSON only, and has a step-up re-sent once.
//
// These live with the screens until the staff lane's contracts are on main: spec 06 §11.3 puts them
// in packages/app-contracts/src/staff/ (L-SAT-04's fragment), and they move there unchanged, with
// the server half validating the same schemas. The answers are what the screens read and nothing
// more: an answer that fails its schema is reported with IDs only and shown as "Couldn't reach Fin".
import { defineContract, noContent, noInput, z } from "@fin/app-contracts";

/** A staff ID (`stf_…`), as a path segment. */
const staffId = z.string().min(1).max(64);

/** The prebuilt roles (spec 02 §8.3); custom staff roles arrive with stretch 3 under other keys. */
export const PREBUILT_STAFF_ROLES = ["viewer", "compliance", "operator", "admin"] as const;

/** The top role: only an Admin gives it, and the last active one stays (spec 02 §8.5, §10.8). */
export const TOP_STAFF_ROLE = "admin";

export const staffMember = z.object({
  id: staffId,
  email: z.string(),
  roleKey: z.string().min(1),
  roleLabel: z.string(),
  /** `pending` until the member's first factor is enrolled ("Hasn't signed in yet"). */
  status: z.enum(["pending", "active"]),
  /** ISO 8601, or null before the first sign-in. */
  lastSignedInAt: z.string().nullable(),
  /** The kinds of second factor the member has, never the factors themselves. */
  factors: z.array(z.enum(["passkey", "authenticator"])),
});
export type StaffMember = z.output<typeof staffMember>;

export const staffListAnswer = z.object({
  staff: z.array(staffMember),
  total: z.number().int().nonnegative(),
  totalCapped: z.boolean().optional(),
});
export type StaffListAnswer = z.output<typeof staffListAnswer>;

/** `GET /api/staff` (`staff.read`): everyone who can use Fin Admin, by address. */
export const listStaff = defineContract({
  name: "staff.list",
  method: "GET",
  path: "/staff",
  input: z.object({
    page: z.number().int().min(1).optional(),
    size: z.number().int().min(1).max(100).optional(),
  }),
  output: staffListAnswer,
});

export const staffRole = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** One sentence: what someone with the role sees and does (spec 02 §8.3's summaries). */
  summary: z.string(),
  builtIn: z.boolean(),
  /** The permission keys the role holds, so the picker can mirror §8.5's giving rule. */
  permissions: z.array(z.string()),
});
export type StaffRole = z.output<typeof staffRole>;

/** `GET /api/staff-roles` (`staff.read`): the prebuilt roles and, with stretch 3, custom ones. */
export const listStaffRoles = defineContract({
  name: "staffRoles.list",
  method: "GET",
  path: "/staff-roles",
  input: noInput,
  output: z.object({ roles: z.array(staffRole) }),
});

/** An enrolment code, shown once (spec 02 §6.5): never stored, logged or kept after the view. */
export const enrolmentCodeAnswer = z.object({
  enrolmentCode: z.string().min(16).max(32),
  expiresAt: z.string(),
});

/** `POST /api/staff` (`staff.add`, intent `staff.add`): the member and the code, once. */
export const addStaff = defineContract({
  name: "staff.add",
  method: "POST",
  path: "/staff",
  input: z.object({ email: z.string().min(3).max(254), roleKey: z.string().min(1) }),
  output: z.object({ staff: staffMember, ...enrolmentCodeAnswer.shape }),
  creates: true,
});

/** `PATCH /api/staff/:staffId` (`staff.role`, intent `staff.role`). The member's sessions end. */
export const changeStaffRole = defineContract({
  name: "staff.changeRole",
  method: "PATCH",
  path: "/staff/:staffId",
  input: z.object({ staffId, roleKey: z.string().min(1) }),
  output: z.object({ staff: staffMember }),
});

/** `POST /api/staff/:staffId/remove` (`staff.remove`, intent `staff.remove`). */
export const removeStaff = defineContract({
  name: "staff.remove",
  method: "POST",
  path: "/staff/:staffId/remove",
  input: z.object({ staffId }),
  output: noContent,
});

/** `POST /api/staff/:staffId/enrolment-code` (`staff.add`, intent): a pending member's new code. */
export const newEnrolmentCode = defineContract({
  name: "staff.newEnrolmentCode",
  method: "POST",
  path: "/staff/:staffId/enrolment-code",
  input: z.object({ staffId }),
  output: enrolmentCodeAnswer,
});

/**
 * `POST /api/enrolment/redeem`: a pending member's own `aal1` session presents the code from the
 * Admin who added them, which opens a 10-minute window to add the first factor (spec 02 §6.5).
 */
export const redeemEnrolmentCode = defineContract({
  name: "enrolment.redeem",
  method: "POST",
  path: "/enrolment/redeem",
  input: z.object({ code: z.string().min(1).max(64) }),
  output: z.object({ windowUntil: z.string() }),
});

export const accountPasskey = z.object({
  id: z.string().min(1),
  /** Fin's device summary ("Chrome on Mac"), set when the passkey was added (spec 02 §5.3). */
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type AccountPasskey = z.output<typeof accountPasskey>;

export const accountSession = z.object({
  id: z.string().min(1),
  /** The device summary of the browser that holds it. */
  device: z.string(),
  current: z.boolean(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
});
export type AccountSession = z.output<typeof accountSession>;

export const accountAnswer = z.object({
  passkeys: z.array(accountPasskey),
  authenticator: z.object({ enabled: z.boolean(), enabledAt: z.string().nullable() }),
  sessions: z.array(accountSession),
});
export type AccountAnswer = z.output<typeof accountAnswer>;

/** `GET /api/account`: the member's own factors and sessions (AdminAccount, "Your sign-in"). */
export const getAccount = defineContract({
  name: "account.get",
  method: "GET",
  path: "/account",
  input: noInput,
  output: accountAnswer,
});

/** `POST /api/account/sessions/revoke-others` (intent `staff.sessions_revoke_others`). */
export const signOutOtherSessions = defineContract({
  name: "account.signOutOthers",
  method: "POST",
  path: "/account/sessions/revoke-others",
  input: noInput,
  output: z.object({ revoked: z.number().int().nonnegative() }),
});

/** `POST /api/account/sessions/:sessionId/revoke` (intent `staff.session_revoke`). */
export const signOutSession = defineContract({
  name: "account.signOutSession",
  method: "POST",
  path: "/account/sessions/:sessionId/revoke",
  input: z.object({ sessionId: z.string().min(1).max(64) }),
  output: noContent,
});
