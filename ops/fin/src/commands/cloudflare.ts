// The Cloudflare commands (spec 01 §7).

import { accessApply } from "../cloudflare/access.ts";
import { emailDomains, emailToken } from "../cloudflare/email.ts";
import { routesApply } from "../cloudflare/routes.ts";
import { tunnelCreate } from "../cloudflare/tunnel.ts";
import { zoneApply } from "../cloudflare/zone.ts";
import type { Command } from "../command.ts";

export const CLOUDFLARE_COMMANDS: readonly Command[] = [
  zoneApply,
  tunnelCreate,
  routesApply,
  accessApply,
  emailDomains,
  emailToken,
];
