import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/no-access/")({
  staticData: { frame: "auth", navId: null, pageName: "No access yet" },
  component: () => <AuthPageStub title="No access yet" />,
});
