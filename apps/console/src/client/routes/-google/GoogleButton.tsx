// "Continue with Google" (spec 02 §5.8, stretch 5), drawn on the SignIn and SignUp boards only when
// the console says Google is on (GET /api/sign-in/methods); with Google off nothing is drawn and
// every Google path answers 404. Pressing it asks the server to start the round trip and sends the
// browser to the provider's address it answered; the server checks everything on the way back.
import { safeNext, useFin } from "@fin/frame";
import { GoogleMark } from "@fin/icons";
import { Button, InlineAlert } from "@fin/ui";
import { useEffect, useRef, useState } from "react";
import { type Failure, failureOf } from "../../api/failures.ts";
import { ceremonyApi } from "../../api/library.ts";
import { OrRule } from "../../components/auth.tsx";
import {
  type GoogleError,
  type GooglePage,
  googleAlert,
  googleReturn,
  googleStart,
  providerUrl,
  signInMethods,
} from "./google.ts";

export interface GoogleButtonProps {
  /** The page the round trip began on, where a refusal comes back to. */
  page: GooglePage;
  /** A safe `next` to keep for after the sign-in (the page checked it). */
  next: string | null;
  disabled?: boolean;
  /** Draws the "or" rule after the button, when the button is drawn. */
  rule?: boolean;
  /** A failure to start (offline, too many tries, our side), for the page's own alert. */
  onFailure(failure: Failure): void;
}

export function GoogleButton(props: GoogleButtonProps) {
  const fin = useFin();
  const [offered, setOffered] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    fin.api(signInMethods, {}).then(
      (methods) => {
        if (live) setOffered(methods.google);
      },
      () => {
        // Not known: the button stays away, and the other ways in still work.
      },
    );
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [fin]);

  if (!offered) return null;

  const start = async () => {
    setBusy(true);
    try {
      const answer = await ceremonyApi()(googleStart, {
        provider: "google",
        ...googleReturn(props.page, safeNext(props.next, fin.routeExists)),
        disableRedirect: true,
      });
      const url = providerUrl(answer.url);
      if (url === null) {
        props.onFailure("ourSide");
        setBusy(false);
        return;
      }
      // The page stays busy while the browser leaves for the provider.
      window.location.assign(url);
    } catch (error) {
      props.onFailure(failureOf(error));
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        leadingIcon={<GoogleMark />}
        loading={busy}
        disabled={props.disabled === true}
        onClick={start}
      >
        Continue with Google
      </Button>
      {props.rule === true ? <OrRule /> : null}
    </>
  );
}

/** What a refused round trip says on the page it came back to. */
export function GoogleRefusal({ error }: { error: GoogleError }) {
  const alert = googleAlert(error);
  return (
    <InlineAlert
      tone={alert.tone}
      title={alert.title}
      live={alert.tone === "danger" ? "assertive" : "polite"}
    >
      {alert.body}
    </InlineAlert>
  );
}
