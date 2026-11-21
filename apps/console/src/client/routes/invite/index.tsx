import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/invite/")({
  staticData: { frame: "auth", navId: null, pageName: "Invitation" },
  component: () => <AuthPageStub title="Invitation" />,
});
