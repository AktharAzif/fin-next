// Confirm your email (VerifyEmail board; spec 02 §5.1 step 2): the sign-up's 8-digit code, or the
// confirm link. The account is made only now, and only in the browser that signed up; then the
// person answers a waiting invitation, or gets their first organisation and Protect your account.
import { createFileRoute } from "@tanstack/react-router";
import { AuthLoading } from "../../components/auth.tsx";
import { CodeEntry, type CodeEntryCopy } from "../../components/CodeEntry.tsx";

export const Route = createFileRoute("/verify-email/")({
  staticData: { frame: "auth", navId: null, pageName: "Confirm your email" },
  pendingComponent: AuthLoading,
  component: VerifyEmailPage,
});

const COPY: CodeEntryCopy = {
  title: "Confirm your email",
  withAddress: (email) => (
    <>
      If {email} is waiting to be confirmed, we sent it an 8-digit code. Enter it here, or open the
      link in the email.
    </>
  ),
  withoutAddress: "Enter the 8-digit code we emailed you, or open the link in the email.",
  codeLabel: "Confirmation code",
  submit: "Confirm email",
  footnote:
    "The code and link work once and expire in 15 minutes. Three wrong codes cancel it; ask for a new one.",
  link: { title: "Confirm your email", line: (email) => email, submit: "Confirm email" },
  elsewhere: { body: "Open it in the browser you signed up in, or type its code there." },
  restartHref: "/sign-up",
};

function VerifyEmailPage() {
  return <CodeEntry copy={COPY} next={null} />;
}
