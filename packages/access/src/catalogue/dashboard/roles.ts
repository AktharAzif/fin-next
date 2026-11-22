// The dashboard's built-in roles (spec 02 §8.2, [SA-11]): immutable rows in code, and no other
// prebuilt dashboard role. Super admin is the top role: only a Super admin makes a Super admin.

export const superAdmin = {
  key: "super_admin",
  label: "Super admin",
  summary:
    "Everything, including deleting the organisation, sending the Production request and making Super admins.",
  holds: "all",
} as const;

export const admin = {
  key: "admin",
  label: "Admin",
  summary:
    "Everything except deleting the organisation, sending the Production request and making Super admins.",
  holds: [
    "customers.read",
    "customers.create",
    "customers.restart",
    "customers.delete",
    "simulator.use",
    "sandbox.reset",
    "money.read",
    "money.beneficiaries",
    "money.transfer",
    "money.simulate",
    "webhooks.read",
    "webhooks.manage",
    "webhooks.roll_secret",
    "webhooks.redeliver",
    "apiKey.read",
    "apiKey.sandbox",
    "apiKey.live",
    "member.read",
    "member.invite",
    "member.role",
    "role.manage",
    "auditLog.read",
    "organization.update",
    "golive.edit",
  ],
} as const;
