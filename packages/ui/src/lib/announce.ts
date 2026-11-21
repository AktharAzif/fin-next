// Spoken updates go through the SDK's announce(), so each document has exactly one polite and one
// assertive live region (spec 06 §3.3, §9). Components never make live regions of their own: no
// role="alert" or "status", no aria-live (a source rule in test/rules.test.ts holds this).
import { announce as sdkAnnounce } from "@ui-sdk/core";
import { type ReactNode, useEffect, useRef } from "react";

export type Priority = "polite" | "assertive";

/** Has screen readers read `text` once: politely, or at once with "assertive". */
export function announce(text: string, priority: Priority = "polite"): void {
  if (typeof document === "undefined" || text.trim() === "") return;
  sdkAnnounce(text, { priority });
}

/** Announces `text` once when the component mounts (a loading region, an alert after an action). */
export function useAnnounceOnMount(text: string | null, priority: Priority = "polite"): void {
  const said = useRef(false);
  useEffect(() => {
    if (said.current || text === null) return;
    said.current = true;
    announce(text, priority);
  }, [text, priority]);
}

/** The words of a node that is plain text, for announcing it; anything else says nothing. */
export function plainText(node: ReactNode): string {
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
