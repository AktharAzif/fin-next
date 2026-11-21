// Invitation (Invite board; spec 02 §9.3, §15.2): the link's token is in the fragment, read once and
// removed from the address bar, then opened (which sets the invitation cookie, so the invitation
// survives a sign-up or sign-in round trip). For the invited person: accept (with their factor if
// they have one) or decline; for anyone else: whom it is for and how to get there. An unusable
// invitation gets one answer whatever the reason, so the page says nothing about why.
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, signOut, useFin } from "@fin/frame";
import { SignOutIcon } from "@fin/icons";
import { AuthCard, Avatar, Button, buttonClasses, InlineAlert } from "@fin/ui";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { failureSentence, toldElsewhere } from "../../api/actions.ts";
import {
  acceptInvitation,
  declineInvitation,
  type InvitationView,
  openInvitation,
  waitingInvitation,
} from "../../api/contracts/invitations.ts";
import { failureOf } from "../../api/failures.ts";
import { destinationAfterSignIn } from "../../auth/after-sign-in.ts";
import { parseInvitationToken, takeFragment } from "../../auth/fragment.ts";
import { AuthLoading } from "../../components/auth.tsx";
import { SectionFailure } from "../../components/page.tsx";
import { formatDay } from "../../format/dates.ts";
import { withArticle } from "../../format/text.ts";
import { withReasonValues } from "../../step-up/reasons.ts";

export const Route = createFileRoute("/invite/")({
  staticData: { frame: "auth", navId: null, pageName: "Invitation" },
  pendingComponent: AuthLoading,
  component: InvitePage,
});

type Page =
  | { kind: "loading" }
  | { kind: "failed"; error: unknown }
  | { kind: "cantUse" }
  | { kind: "declined"; orgName: string }
  | { kind: "invitation"; invitation: InvitationView };

function Heading({ invitation }: { invitation: InvitationView }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar name={invitation.orgName} kind="business" size={40} />
      <span className="text-label text-text-secondary">{invitation.orgName}</span>
    </div>
  );
}

function InvitePage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const [page, setPage] = useState<Page>({ kind: "loading" });
  const [busy, setBusy] = useState<"accept" | "decline" | "signOut" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const token = useRef<string | null | undefined>(undefined);
  if (token.current === undefined) token.current = parseInvitationToken(takeFragment());

  const load = async () => {
    setPage({ kind: "loading" });
    try {
      const link = token.current ?? null;
      const invitation =
        link === null
          ? await fin.api(waitingInvitation, {})
          : await fin.api(openInvitation, { token: link });
      // The cookie holds it now: the token is not needed again.
      token.current = null;
      setPage({ kind: "invitation", invitation });
    } catch (error) {
      const failure = failureOf(error);
      setPage(failure === "notFound" ? { kind: "cantUse" } : { kind: "failed", error });
    }
  };

  // Opened once, when the page mounts.
  useEffect(() => {
    void load();
  }, []);

  const accept = async (invitation: InvitationView) => {
    setBusy("accept");
    setFailed(null);
    try {
      await withReasonValues({}, () =>
        fin.api(acceptInvitation, { invitationId: invitation.invitationId }),
      );
      const href = await destinationAfterSignIn(fin, "/");
      await router.navigate({ href, replace: true });
    } catch (error) {
      if (failureOf(error) === "notFound") setPage({ kind: "cantUse" });
      else if (!toldElsewhere(error)) setFailed(failureSentence(error));
    } finally {
      setBusy(null);
    }
  };

  const decline = async (invitation: InvitationView) => {
    setBusy("decline");
    setFailed(null);
    try {
      await fin.api(declineInvitation, { invitationId: invitation.invitationId });
      setPage({ kind: "declined", orgName: invitation.orgName });
    } catch (error) {
      if (failureOf(error) === "notFound") setPage({ kind: "cantUse" });
      else if (!toldElsewhere(error)) setFailed(failureSentence(error));
    } finally {
      setBusy(null);
    }
  };

  const logOut = async () => {
    setBusy("signOut");
    const ended = await signOut({ app: "console" });
    if (!ended) {
      setBusy(null);
      setFailed("You’re still signed in. Try again.");
    }
  };

  const goOn = async () => {
    const href = await destinationAfterSignIn(fin, "/");
    await router.navigate({ href, replace: true });
  };

  switch (page.kind) {
    case "loading":
      return <AuthLoading />;
    case "failed":
      return (
        <AuthCard title="Invitation">
          <SectionFailure title="Couldn’t open the invitation" error={page.error} onRetry={load} />
        </AuthCard>
      );
    case "cantUse":
      return (
        <AuthCard
          title="This invitation can’t be used"
          description="It has expired, was deleted or was already answered. Ask the person who invited you to send a new one."
        >
          <RouterLink href="/sign-in" className={buttonClasses("primary", "lg")}>
            Go to sign in
          </RouterLink>
        </AuthCard>
      );
    case "declined":
      return (
        <AuthCard
          title="Invitation declined"
          description={`You won’t join ${page.orgName}. They can invite you again.`}
        >
          <Button variant="primary" size="lg" onClick={goOn}>
            Continue
          </Button>
        </AuthCard>
      );
    default:
      break;
  }

  const invitation = page.invitation;
  const expires = formatDay(invitation.expiresAt);
  const role = withArticle(invitation.roleLabel);

  if (invitation.state === "for_you") {
    return (
      <AuthCard
        title={`Join ${invitation.orgName}`}
        description={
          <>
            <span className="text-text-primary">{invitation.inviterName}</span> (
            {invitation.inviterEmail}) invited{" "}
            <span className="text-text-primary">{invitation.email ?? invitation.emailMasked}</span>{" "}
            as {role}.
          </>
        }
      >
        <Heading invitation={invitation} />
        {failed === null ? null : (
          <InlineAlert tone="danger" title="That didn’t work." live="assertive">
            {failed}
          </InlineAlert>
        )}
        <div className="flex flex-col gap-3">
          <Button
            variant="primary"
            size="lg"
            loading={busy === "accept"}
            disabled={busy === "decline"}
            onClick={() => accept(invitation)}
          >
            Accept invitation
          </Button>
          <Button
            variant="secondary"
            size="lg"
            loading={busy === "decline"}
            disabled={busy === "accept"}
            onClick={() => decline(invitation)}
          >
            Decline
          </Button>
        </div>
        <p className="m-0 text-caption text-text-tertiary">
          The invitation is for {invitation.email ?? invitation.emailMasked} only and expires on{" "}
          {expires}.
        </p>
      </AuthCard>
    );
  }

  const forLine = `This invitation is for ${invitation.emailMasked}, as ${role}.`;
  if (invitation.state === "other_account") {
    return (
      <AuthCard title={`Join ${invitation.orgName}`} description={forLine}>
        <Heading invitation={invitation} />
        <InlineAlert
          tone="info"
          title={`You’re signed in as ${invitation.signedInEmail ?? "someone else"}.`}
        >
          This invitation is for {invitation.emailMasked}. Log out, then sign in with that address.
        </InlineAlert>
        {failed === null ? null : (
          <InlineAlert tone="danger" title="That didn’t work." live="assertive">
            {failed}
          </InlineAlert>
        )}
        <Button
          variant="secondary"
          size="lg"
          leadingIcon={<SignOutIcon />}
          loading={busy === "signOut"}
          onClick={logOut}
        >
          Log out
        </Button>
        <p className="m-0 text-caption text-text-tertiary">It expires on {expires}.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`Join ${invitation.orgName}`} description={forLine}>
      <Heading invitation={invitation} />
      <div className="flex flex-col gap-3">
        <RouterLink href="/sign-up" className={buttonClasses("primary", "lg")}>
          Create an account
        </RouterLink>
        <RouterLink href="/sign-in?next=%2Finvite" className={buttonClasses("secondary", "lg")}>
          I already have an account
        </RouterLink>
      </div>
      <p className="m-0 text-caption text-text-tertiary">It expires on {expires}.</p>
    </AuthCard>
  );
}
