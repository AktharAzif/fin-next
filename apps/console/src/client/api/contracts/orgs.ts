// Organisations (spec 02 §9.1, §14.2): the person's organisations, the first one, create, and the
// current organisation's profile, rename and delete. Organisation routes carry `Fin-Organization`
// (api() adds the viewer's current one). The client's reading of §14.2 until L-SAT-03's
// app-contracts fragment (`src/orgs/**`) carries them; unknown fields are kept.
import { defineContract, noInput, z } from "@fin/app-contracts";

export const organisationRow = z.looseObject({
  orgId: z.string().min(1),
  name: z.string(),
  roleKey: z.string(),
  roleLabel: z.string(),
  roleKnown: z.boolean().optional(),
  liveStatus: z.string(),
});
export type OrganisationRow = z.output<typeof organisationRow>;

export const myOrganisations = defineContract({
  name: "orgs.list",
  method: "GET",
  path: "/orgs",
  input: z.object({
    page: z.number().int().positive().optional(),
    size: z.number().int().positive().max(100).optional(),
  }),
  output: z.looseObject({
    items: z.array(organisationRow),
    total: z.number().int().nonnegative(),
  }),
});

export const createOrganisation = defineContract({
  name: "orgs.create",
  method: "POST",
  path: "/orgs",
  creates: true,
  input: z.object({ name: z.string().max(200) }),
  output: z.looseObject({ orgId: z.string().min(1) }),
});

/** The first organisation of a person with none (spec 02 §5.9): no step-up, no input. */
export const createFirstOrganisation = defineContract({
  name: "orgs.createFirst",
  method: "POST",
  path: "/orgs/first",
  creates: true,
  input: noInput,
  output: z.looseObject({ orgId: z.string().min(1) }),
});

export const currentOrganisation = defineContract({
  name: "org.get",
  method: "GET",
  path: "/org",
  organization: true,
  input: noInput,
  output: z.looseObject({
    orgId: z.string().min(1),
    name: z.string(),
    createdAt: z.string().min(1),
    liveStatus: z.string(),
    roleKey: z.string(),
    roleLabel: z.string(),
  }),
});
export type CurrentOrganisation = z.output<(typeof currentOrganisation)["output"]>;

export const renameOrganisation = defineContract({
  name: "org.rename",
  method: "PATCH",
  path: "/org",
  organization: true,
  input: z.object({ name: z.string().max(200) }),
  output: z.unknown(),
});

export const deleteOrganisation = defineContract({
  name: "org.delete",
  method: "DELETE",
  path: "/org",
  organization: true,
  input: z.object({ confirmName: z.string().max(200) }),
  output: z.unknown(),
});

/** `live_status` once Fin approved the organisation for Production (spec 02 §9.1). */
export function isApproved(liveStatus: string): boolean {
  return liveStatus === "approved" || liveStatus === "live";
}
