// The session ended under the page (its 10 minutes at `aal1` ran out, too many wrong tries at a
// step-up, a sign-out elsewhere, or Access now names someone else; spec 02 §11.4, §14.1). The realm
// has already ended it, so there is nothing to sign out: the page hides and loads sign-in, which
// says "You were signed out. Sign in again." (FW-C14: nothing of the page stays in memory).
export function signInAgain(): void {
  const root = document.getElementById("root");
  if (root !== null) root.hidden = true;
  window.location.assign("/sign-in?ended=1");
}
