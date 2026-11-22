// What the API keys area's two notices share (spec 05 §4.10, spec 02 §17.2): the one link, to the
// console's API keys page, and the key's parameters. A key's ID (10 upper-case Crockford characters)
// is safe to show; its prefix, which begins `fin_test_` or `fin_live_`, is not passed, as every
// display value refuses that shape, and neither is the secret. A key's name is a value a member
// chose, so it is hidden, never refused, when it is not a clean label.
import { z } from "zod";
import type { Link } from "../../classes.ts";
import { nameText } from "../../params.ts";

export const API_KEYS: Link = Object.freeze({
  label: "Open API keys",
  host: "console",
  path: "/developers/keys",
});

/** The key's 10-character ID. */
export const keyId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{10}$/u);

/** The key's name, as the console stored it (at most 60 characters). */
export const keyName = nameText(60);

/** "Sandbox" for a test key, "Production" for a live one ([UI-08]). */
export function environmentLabel(mode: "sandbox" | "live"): string {
  return mode === "live" ? "Production" : "Sandbox";
}
