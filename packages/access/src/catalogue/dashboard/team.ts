// The dashboard's Team permissions (spec 02 §8.2, [SA-11]). The team area's fragment. Inviting and
// removing people stay one permission until the owner answers spec 02 open item 15.
import type { GroupSpec } from "../../engine/types.ts";

export const team = {
  key: "team",
  label: "Team",
  cant: "change the team",
  permissions: [
    {
      key: "member.read",
      label: "See the team",
      description: "Who is here, their roles and invitations.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "the team" },
    },
    {
      key: "member.invite",
      label: "Invite and remove people",
      description: "Send invitations and take people off the team.",
      needs: ["member.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "invite and remove people" },
    },
    {
      key: "member.role",
      label: "Change people's roles",
      description: "Give someone another role, never one that can do more than you.",
      needs: ["member.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "change people's roles" },
    },
    {
      key: "role.manage",
      label: "Create and change roles",
      description: "Roles like this one, and what each allows.",
      needs: ["member.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "create and change roles" },
    },
  ],
} as const satisfies GroupSpec;
