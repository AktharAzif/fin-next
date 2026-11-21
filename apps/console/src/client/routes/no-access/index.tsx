// No access yet (NoAccess board; spec 02 §8.1, §15.2): every role the person holds is one Fin does
// not know, so it allows nothing ([SA-11]: an unknown role fails closed). The page names the
// organisations and their stored roles, offers a waiting invitation, and logging out.
import type { ConsoleViewer } from "@fin/app-contracts";
import { signInHref, signOut, useFin, useStore } from "@fin/frame";
import { SignOutIcon } from "@fin/icons";
import { AuthCard, Avatar, Button, InlineAlert } from "@fin/ui";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { failureSentence, toldElsewhere } from "../../api/actions.ts";
import { acceptInvitation } from "../../api/contracts/invitations.ts";
import { destinationAfterSignIn, stepFor } from "../../auth/after-sign-in.ts";
import { AuthLoading } from "../../components/auth.tsx";
import { withArticle } from "../../format/text.ts";
import { withReasonValues } from "../../step-up/reasons.ts";

export const Route = createFileRoute("/no-access/")({
  staticData: { frame: "auth", navId: null, pageName: "No access yet" },
  // For a person whose every role is unknown (or who has none); anyone else goes on.
  beforeLoad: ({ context }) => {
    const viewer = context.fin.viewer.get();
    let href: string | null = null;
    if (viewer === null) {
      href = signInHref({ pathname: "/", search: "" }, context.fin.routeExists);
    } else if (viewer.gate !== "ok") {
      const step = stepFor(viewer, null, context.fin.routeExists);
      href = step.kind === "go" ? step.href : null;
    } else if (viewer.memberships.some((m) => m.roleKnown)) {
      href = "/";
    }
    if (href !== null) {
      throw redirect({ href, replace: true } as unknown as Parameters<typeof redirect>[0]);
    }
  },
  pendingComponent: AuthLoading,
  component: NoAccessPage,
});

function NoAccessPage() {
  const fin = useFin<ConsoleViewer>();
  const router = useRouter();
  const viewer = useStore(fin.viewer);
  const [busy, setBusy] = useState<"signOut" | "accept" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (viewer === null || viewer.gate === "factor_step") return <AuthLoading />;
  const unknown = viewer.memberships.filter((m) => !m.roleKnown);
  const invitation = viewer.invitations[0];

  const description =
    unknown.length === 0
      ? "You don’t belong to an organisation."
      : unknown.length === 1
        ? `Your role in ${unknown[0]?.name ?? ""} isn’t one Fin recognises, so it allows nothing. A Super admin of that organisation can change it.`
        : "Your role in each of these organisations isn’t one Fin recognises, so it allows nothing. A Super admin of each organisation can change it.";

  const logOut = async () => {
    setBusy("signOut");
    setFailed(null);
    const ended = await signOut({ app: "console" });
    if (!ended) {
      setBusy(null);
      setFailed("signOut");
    }
  };

  const accept = async () => {
    if (invitation === undefined) return;
    setBusy("accept");
    setFailed(null);
    try {
      await withReasonValues("invitation.accept", {}, () =>
        fin.api(acceptInvitation, { invitationId: invitation.invitationId }),
      );
      const href = await destinationAfterSignIn(fin, "/");
      await router.navigate({ href, replace: true });
    } catch (error) {
      if (!toldElsewhere(error)) setFailed(failureSentence(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthCard title="No access yet" description={description}>
      {unknown.length === 0 ? null : (
        <ul aria-label="Your organisations" className="m-0 flex list-none flex-col gap-3 p-0">
          {unknown.map((membership) => (
            <li key={membership.orgId} className="flex items-center gap-3">
              <Avatar name={membership.name} kind="business" size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-label text-text-primary">{membership.name}</span>
                <span className="text-caption text-text-tertiary">
                  Stored role: <span className="font-mono">{membership.roleKey}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {invitation === undefined ? null : (
        <InlineAlert
          tone="info"
          title={`${invitation.orgName} invited you to join as ${withArticle(invitation.roleLabel)}.`}
          action={
            <Button variant="secondary" size="sm" loading={busy === "accept"} onClick={accept}>
              Accept invitation
            </Button>
          }
        />
      )}
      {failed === null ? null : failed === "signOut" ? (
        <InlineAlert tone="danger" title="You’re still signed in." live="assertive">
          Try again.
        </InlineAlert>
      ) : (
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
      <p className="m-0 text-caption text-text-tertiary">Signed in as {viewer.user.email}.</p>
    </AuthCard>
  );
}
