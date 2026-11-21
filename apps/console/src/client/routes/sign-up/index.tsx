import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/sign-up/")({
  staticData: { frame: "auth", navId: null, pageName: "Create your account" },
  component: () => <AuthPageStub title="Create your account" />,
});
