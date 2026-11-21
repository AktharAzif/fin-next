import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/sign-in/code")({
  staticData: { frame: "auth", navId: null, pageName: "Check your email" },
  component: () => <AuthPageStub title="Check your email" />,
});
