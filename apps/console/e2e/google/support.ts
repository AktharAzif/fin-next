// What Google's journeys share (spec 02 §5.8, §19.3; EXECUTION S-02: "the Google round trip ...
// proven in Playwright against a mock identity provider"): where the fixture OpenID provider
// listens in a journey run, the client the console is registered as there, and the fixture's
// control calls, which only Node-side test code makes. Nothing here is a real client or secret:
// the client ID is a test name, and the secret is made at run time by whoever starts the servers.
import { appOrigin } from "@fin/testing";

/**
 * The release the journey's API half reports (`Fin-Release`) and its env.json names, so the frame
 * sees one release: a test value in the commit-hash shape the server requires.
 */
export const JOURNEY_RELEASE = "0123456789abcdef0123456789abcdef01234567";

/**
 * The journey's own ports, beside the harness's (4101 to 4111, 4201 to 4212): run.ts serves the
 * built console on a static host of its own, so a journey run never shares a port, and so never a
 * static host or an API half, with another run on the same machine.
 */
export const GOOGLE_JOURNEY_PORTS = { static: 4131, api: 4231, provider: 4121 } as const;

/** The console's origin in this run: the journey's own host when run.ts set it, else the role's. */
export const CONSOLE_ORIGIN = process.env.FIN_E2E_GOOGLE_CONSOLE_ORIGIN ?? appOrigin("console");

/** The fixture provider's port in a journey run (beside the harness's 4110 and 4111). */
export const OAUTH_FIXTURE_PORT = GOOGLE_JOURNEY_PORTS.provider;
export const OAUTH_FIXTURE_ORIGIN =
  process.env.FIN_E2E_OAUTH_FIXTURE ?? `http://127.0.0.1:${OAUTH_FIXTURE_PORT}`;
export const OAUTH_CLIENT_ID = "fin-console-e2e.apps.example.com";
/** Exactly the redirect URI CR-12 registers, on the journey's console host. */
export const OAUTH_REDIRECT_URI = `${CONSOLE_ORIGIN}/api/auth/callback/google`;

export interface FixtureChoice {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  readonly emailVerified?: boolean;
}

async function control(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${OAUTH_FIXTURE_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`the fixture provider's control answered ${response.status}`);
}

export const provider = {
  /** The account the next sign-in at the provider picks; `"deny"` cancels it. */
  next: (choice: FixtureChoice | "deny") => control("/control/next", { choice }),
  /** Whether the fixture provider answers in this run. */
  async running(): Promise<boolean> {
    try {
      const response = await fetch(`${OAUTH_FIXTURE_ORIGIN}/control/requests`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};
