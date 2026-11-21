// Zod for the contracts, configured before any schema exists. Zod compiles object schemas with
// `new Function` unless `jitless` is set, and probes for it when the first object schema is built.
// Under the browser's page policy (`script-src 'self'`, no 'unsafe-eval', [SA-45]) that probe is a
// `securitypolicyviolation` even though Zod catches the throw, so every schema the web apps share is
// built here, with `jitless` on, and the apps take `z` from @fin/app-contracts, never from "zod".
import { z } from "zod";

z.config({ jitless: true });

export { z };
