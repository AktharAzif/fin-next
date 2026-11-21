// Fin Admin's prebuilt staff roles (spec 02 §8.3, [SA-12]): immutable rows in code; custom staff
// roles may be added (§10.7). Admin is the top role: only an Admin makes an Admin.

const viewerHolds = [
  "golive.read",
  "customers.read",
  "rfis.read",
  "organisations.read",
  "money.read",
  "audit.read",
  "staff.read",
] as const;

const complianceHolds = [
  ...viewerHolds,
  "customers.reveal",
  "documents.view",
  "customers.decide",
  "rfis.manage",
  "forms.manage",
  "golive.decide",
  "views.manage",
] as const;

const operatorHolds = [
  ...complianceHolds,
  "organisations.pause",
  "organisations.approvals",
  "switches.manage",
] as const;

export const viewer = {
  key: "viewer",
  label: "Viewer",
  summary:
    "Sees everything in Fin Admin except personal details and documents, and changes nothing.",
  holds: viewerHolds,
} as const;

export const compliance = {
  key: "compliance",
  label: "Compliance",
  summary:
    "Reviews and decides customers and Production access requests, handles requests for information and forms, and sees personal details and documents.",
  holds: complianceHolds,
} as const;

export const operator = {
  key: "operator",
  label: "Operator",
  summary:
    "Does everything Compliance does, pauses and restores Production access, changes customer approvals and uses the kill switches.",
  holds: operatorHolds,
} as const;

export const admin = {
  key: "admin",
  label: "Admin",
  summary: "Does everything, including staff, staff roles, reasons and message templates.",
  holds: "all",
} as const;
