import { createFileRoute } from "@tanstack/react-router";
import { AppPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/settings/team")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings", needs: ["member.read"] },
  component: () => <AppPageStub title="Settings" />,
});
