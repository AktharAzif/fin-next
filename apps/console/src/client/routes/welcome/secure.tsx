import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/welcome/secure")({
  staticData: { frame: "auth", navId: null, pageName: "Protect your account" },
  component: () => <AuthPageStub title="Protect your account" />,
});
