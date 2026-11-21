// Check your email (SignInCode board; spec 02 §5.2): the 8-digit code, or the sign-in link
// (`#e=<email>&c=<code>`), which signs in with one press only in the browser that asked for it.
import { createFileRoute } from "@tanstack/react-router";
import { withNext } from "../../auth/after-sign-in.ts";
import { AuthLoading } from "../../components/auth.tsx";
import { CodeEntry, type CodeEntryCopy } from "../../components/CodeEntry.tsx";

export const Route = createFileRoute("/sign-in/code")({
  staticData: { frame: "auth", navId: null, pageName: "Check your email" },
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" && search.next !== "" ? { next: search.next } : {},
  pendingComponent: AuthLoading,
  component: SignInCodePage,
});

function copyFor(next: string | null): CodeEntryCopy {
  return {
    title: "Check your email",
    withAddress: (email) => (
      <>We sent a sign-in link to {email}. Open it on this device to continue.</>
    ),
    withoutAddress: "Open the sign-in link we emailed you on this device, or enter its code.",
    codeLabel: "Or enter the 8-digit code from the email",
    submit: "Continue",
    footnote:
      "The link and code work once and expire in 15 minutes. If it hasn’t arrived, check spam.",
    link: { title: "Sign in to Fin", line: (email) => <>As {email}.</>, submit: "Sign in" },
    elsewhere: { body: "Open it there, or enter your email and its code here." },
    restartHref: withNext("/sign-in", next),
  };
}

function SignInCodePage() {
  const next = Route.useSearch().next ?? null;
  return <CodeEntry copy={copyFor(next)} next={next} />;
}
