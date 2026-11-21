import { createFileRoute } from "@tanstack/react-router";
import { AppPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/staff/")({
  staticData: { frame: "app", navId: "staff", pageName: "Staff", needs: ["staff.read"] },
  component: () => <AppPageStub title="Staff" />,
});
