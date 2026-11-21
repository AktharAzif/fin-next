// `/sign-in` (AdminSignIn; spec 06 §7.2): `?ended=1` when the session ended under the page. A member
// of staff already part-way through signing in goes on to the factor step, and one signed in goes
// home; this page is for no session at all.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { SignInPage } from "../../sign-in/SignInPage.tsx";

interface SignInSearch {
  ended?: true;
}

export const Route = createFileRoute("/sign-in/")({
  staticData: { frame: "auth", navId: null, pageName: "Sign in" },
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    search.ended === 1 || search.ended === "1" || search.ended === true ? { ended: true } : {},
  beforeLoad: ({ context }) => {
    const viewer = context.fin.viewer.get();
    if (viewer?.state === "ok") throw redirect({ to: "/", replace: true });
    if (viewer?.state === "pending" || viewer?.state === "factor_step") {
      throw redirect({ to: "/sign-in/factor", replace: true });
    }
  },
  component: SignInRoute,
});

function SignInRoute() {
  const { ended } = Route.useSearch();
  return <SignInPage ended={ended === true} />;
}
