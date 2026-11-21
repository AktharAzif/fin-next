// The console's password routes (spec 02 §5.7, stretch 2), beside the realm's own password paths
// under `/api/auth` (its allowlist, §4.2):
//   - `GET /api/sign-in/methods`: which sign-in methods this deployment offers beyond the passkey
//     and the emailed code, so the static, environment-neutral pages draw the password step only
//     when passwords are on. The same answer for everyone; it reads no session and counts nothing.
//   - `POST /api/reset-password/code-link`: the reset link's check (NewPassword board): whether
//     this browser asked for the address's live reset, by its own code-browser cookie only.
import * as z from "zod";
import { email } from "./schemas.ts";
import { route } from "./types.ts";

export const PASSWORD_ROUTES = [
  route({
    id: "signInMethods",
    method: "GET",
    path: "/sign-in/methods",
    guard: "public",
    scope: "public",
    stepUp: "none",
    assurance: "none",
    body: "none",
    query: z.strictObject({}),
    limits: [],
    audit: [],
  }),
  route({
    id: "resetCodeLink",
    method: "POST",
    path: "/reset-password/code-link",
    guard: "public",
    scope: "public",
    stepUp: "none",
    assurance: "none",
    body: z.strictObject({ email }),
    query: "none",
    limits: ["code_sign_in"],
    audit: [],
  }),
] as const;
