// identity/already-registered (spec 02 §5.1, §17.2): sign-up was tried for an address that already
// has an account. The sign-up answer is the same either way; only this email tells the owner.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { timeBox } from "../shared.ts";

export const alreadyRegistered = defineTemplate({
  name: "already-registered",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Sign-ups tried with your address",
  params: z.strictObject({ time: param.time }),
  sample: { time: "2026-11-21T04:30:00.000Z" },
  render: (p) => ({
    subject: "You already have a Fin account",
    heading: "You already have a Fin account",
    preview: "Someone tried to sign up with this address. Nothing was changed.",
    paragraphs: [
      "Someone tried to create a Fin account with this email address. You already have one, so nothing was changed.",
    ],
    boxes: [timeBox("When", p.time)],
    link: { label: "Sign in", host: "console", path: "/sign-in" },
    footer: ["If this was you, sign in instead. If it wasn't, you don't need to do anything."],
  }),
});
