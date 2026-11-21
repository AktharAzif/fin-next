import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/sign-in/two-factor")({
  staticData: { frame: "auth", navId: null, pageName: "Second factor" },
  component: () => <AuthPageStub title="Second factor" />,
});
