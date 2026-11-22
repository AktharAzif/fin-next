// AdminAudit's data: one page of the staff log for the URL's filters and cursor (spec 02 §14.3).
// A failure is the page's `failed` state (the header and the filters stay, the table says it
// couldn't load), never the route's error page; a role without `audit.read` reads nothing and the
// frame says why (the server refuses regardless).
import type { StaffViewer } from "@fin/app-contracts";
import { type FinRuntime, isApiError } from "@fin/frame";
import { type AuditPageAnswer, listAudit } from "./contract.ts";
import { type AuditSearch, apiQuery } from "./search.ts";

export type AuditData =
  | { readonly kind: "ready"; readonly page: AuditPageAnswer }
  | { readonly kind: "failed"; readonly requestId: string | null; readonly offline: boolean }
  | { readonly kind: "notAllowed" };

export async function loadAudit(
  fin: Pick<FinRuntime<StaffViewer>, "api" | "viewer">,
  search: Omit<AuditSearch, "view">,
): Promise<AuditData> {
  const viewer = fin.viewer.get();
  if (viewer?.state !== "ok" || !viewer.permissions.includes("audit.read")) {
    return { kind: "notAllowed" };
  }
  try {
    return { kind: "ready", page: await fin.api(listAudit, apiQuery(search)) };
  } catch (error) {
    return {
      kind: "failed",
      requestId: isApiError(error) ? error.requestId : null,
      offline: isApiError(error) && error.kind === "network",
    };
  }
}
