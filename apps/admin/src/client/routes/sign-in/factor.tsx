// `/sign-in/factor` (AdminSecondFactor; spec 06 §7.2): an `aal1` staff session only. No session goes
// to sign-in; a working session goes home.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FactorPage } from "../../sign-in/FactorPage.tsx";

export const Route = createFileRoute("/sign-in/factor")({
  staticData: { frame: "auth", navId: null, pageName: "Second factor" },
  beforeLoad: ({ context }) => {
    const viewer = context.fin.viewer.get();
    if (viewer?.state === "ok") throw redirect({ to: "/", replace: true });
    if (viewer === null || viewer.state === "signed_out") {
      throw redirect({ to: "/sign-in", replace: true });
    }
  },
  component: FactorPage,
});
