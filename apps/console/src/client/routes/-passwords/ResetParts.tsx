// What the two reset pages share (ResetPassword and NewPassword boards; spec 02 §5.7).
import { Button } from "@fin/ui";
import { useRouter } from "@tanstack/react-router";
import { AuthMessage } from "../../components/auth.tsx";

/** Another link can be asked this long after the last (the boards' countdown). */
export const RESEND_SECONDS = 45;

/** `0:38`: the wait before another link, as the board draws it. */
export function countdownLabel(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The SignIn board's "Page not found", for a deployment without passwords. */
export function NoPasswords() {
  const router = useRouter();
  return (
    <AuthMessage
      title="Page not found"
      description="The address may be wrong, or the page may have moved."
      action={
        <Button
          variant="primary"
          size="lg"
          onClick={() => void router.navigate({ href: "/sign-in", replace: true })}
        >
          Go to sign in
        </Button>
      }
    />
  );
}
