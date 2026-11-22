// Fin Admin's `/` (spec 06 §7.2; S6-25): it opens the first list the staff role can see whose screen
// exists (Staff on Saturday). A role that can open none sees why, in the frame.
import { guardAdminHome, RouteNotAllowed } from "@fin/frame";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  staticData: { frame: "app", navId: null, pageName: "Fin Admin" },
  beforeLoad: (input): void => guardAdminHome(input),
  component: RouteNotAllowed,
});
