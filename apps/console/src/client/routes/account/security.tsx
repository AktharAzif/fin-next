import { createFileRoute } from "@tanstack/react-router";
import { AppPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/account/security")({
  staticData: { frame: "app", navId: null, pageName: "Account security" },
  component: () => <AppPageStub title="Account security" />,
});
