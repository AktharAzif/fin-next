import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/sign-in/")({
  staticData: { frame: "auth", navId: null, pageName: "Sign in" },
  component: () => <AuthPageStub title="Sign in to Fin" />,
});
