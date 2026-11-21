import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/sign-in/backup-code")({
  staticData: { frame: "auth", navId: null, pageName: "Backup code" },
  component: () => <AuthPageStub title="Backup code" />,
});
