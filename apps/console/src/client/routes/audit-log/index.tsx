import { createFileRoute } from "@tanstack/react-router";
import { AppPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/audit-log/")({
  staticData: { frame: "app", navId: "audit-log", pageName: "Audit log", needs: ["auditLog.read"] },
  component: () => <AppPageStub title="Audit log" />,
});
