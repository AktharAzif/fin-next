// `/p`: a person's own link (spec 03 §2.5). The token arrived in the fragment and is already gone from
// the address bar (../../link-token.ts); L-SUN-06 builds the flow that opens the link session.
import { createFileRoute } from "@tanstack/react-router";
import { AuthPageStub } from "../../components/RouteStub.tsx";

export const Route = createFileRoute("/p/")({
  staticData: { frame: "auth", navId: null, pageName: "Verify" },
  component: () => <AuthPageStub title="Verify" />,
});
