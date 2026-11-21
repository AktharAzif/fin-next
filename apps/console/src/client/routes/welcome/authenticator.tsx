import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/welcome/authenticator")({
  staticData: { frame: "auth", navId: null, pageName: "Set up your authenticator" },
  component: () => <AuthPageStub title="Set up your authenticator" />,
});
