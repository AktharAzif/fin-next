// `/sign-in` (AdminSignIn; spec 06 §7.2): `?ended=1` when the session ended under the page, and
// `?error=<code>` when a Google round trip came back refused (stretch 5: the googleFailed state;
// a successful one comes back here with no query). A member of staff already part-way through
// signing in goes on to the factor step, and one signed in goes home; this page is for no session
// at all.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type GoogleError, googleErrorOf } from "../../auth/google.ts";
import { SignInPage } from "../../sign-in/SignInPage.tsx";

interface SignInSearch {
  ended?: true;
  error?: GoogleError;
}

export const Route = createFileRoute("/sign-in/")({
  staticData: { frame: "auth", navId: null, pageName: "Sign in" },
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    const ended = search.ended === 1 || search.ended === "1" || search.ended === true;
    const error = googleErrorOf(search.error);
    return { ...(ended ? { ended: true } : {}), ...(error === null ? {} : { error }) };
  },
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
  const { ended, error } = Route.useSearch();
  return <SignInPage ended={ended === true} googleError={error ?? null} />;
}
