// `/audit` (AdminAudit; spec 06 §7.2): `audit.read`; `view=<aud_…>` opens an entry. The loader
// reads one page for the URL's filters and cursor; opening or stepping through entries changes
// only `view`, which is not a loader dependency, so it reads no list again (FW-C11). Its own
// skeleton draws while a page loads.
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AuditPage, AuditSkeleton } from "./-audit/AuditPage.tsx";
import { loadAudit } from "./-audit/load.ts";
import { type AuditSearch, listDeps, readAuditSearch } from "./-audit/search.ts";

export const Route = createFileRoute("/audit/")({
  staticData: { frame: "app", navId: "audit", pageName: "Audit log", needs: ["audit.read"] },
  validateSearch: (search: Record<string, unknown>): AuditSearch => readAuditSearch(search),
  loaderDeps: ({ search }) => listDeps(search),
  loader: ({ context, deps }) => loadAudit(context.fin, deps),
  pendingComponent: AuditSkeleton,
  component: AuditRoute,
});

function AuditRoute() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  return (
    <AuditPage
      data={data}
      search={search}
      go={(next, push = false) => void navigate({ search: next, replace: !push })}
      onReload={() => router.invalidate()}
    />
  );
}
