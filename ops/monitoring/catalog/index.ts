// Every catalogue fragment, by area. A fragment file not listed here fails monitoring:check, so a
// lane that adds `catalog/<area>.ts` adds its line here in the same pull request.
import { entries as audit } from "./audit.ts";
import { entries as database } from "./database.ts";
import { entries as email } from "./email.ts";
import { entries as platform } from "./platform.ts";
import type { CatalogEntry } from "./types.ts";
import { entries as webHost } from "./web-host.ts";

export const fragments: Readonly<Record<string, readonly CatalogEntry[]>> = {
  platform,
  audit,
  database,
  email,
  "web-host": webHost,
};
