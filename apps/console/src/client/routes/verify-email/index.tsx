import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/verify-email/")({
  staticData: { frame: "auth", navId: null, pageName: "Confirm your email" },
  component: () => <AuthPageStub title="Confirm your email" />,
});
