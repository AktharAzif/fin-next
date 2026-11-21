import { createFileRoute } from "@tanstack/react-router";
import { AppPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/settings/organisation")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings" },
  component: () => <AppPageStub title="Settings" />,
});
