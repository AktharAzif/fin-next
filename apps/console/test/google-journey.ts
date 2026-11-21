// node apps/console/test/google-journey.ts   (google/run.ts starts it; Ctrl-C or SIGTERM stops it)
//
// Starts what Google's journey needs behind the console's static host (spec 02 §5.8, §19.3): the
// fixture OpenID provider on its port, and the console's real API half on the role's API port (the
// static host's `/api/` route forwards there with the test ingress proof), with Google switched on
// against the fixture, on a database of its own cloned from the orgs harness's template (Postgres
// 18, from FIN_TEST_DATABASE_URL). The client secret and the realm's secrets are made here, at run
// time. It lives in test/ rather than e2e/ because it loads the API half, which the browser-side
// e2e program does not typecheck; src/server/google-journey.db.test.ts runs it on free ports.
import { randomBytes } from "node:crypto";
import { type RunningService, runService } from "@fin/server";
import { appOrigin, testIngressProof } from "@fin/testing";
import { createTestDatabase, type TestDatabase } from "../../../packages/orgs/test/index.ts";
import {
  OAuthFixture,
  type RunningOAuthFixture,
  startOAuthFixture,
} from "../../../packages/testing/src/oauth/fixture.ts";
import {
  CONSOLE_ORIGIN,
  GOOGLE_JOURNEY_PORTS,
  JOURNEY_RELEASE,
  OAUTH_CLIENT_ID,
  OAUTH_FIXTURE_PORT,
  OAUTH_REDIRECT_URI,
} from "../e2e/google/support.ts";
import { defineConsoleService } from "../src/server/main.ts";

export interface GoogleJourneyServers {
  readonly provider: RunningOAuthFixture;
  readonly api: RunningService;
  readonly database: TestDatabase;
  close(): Promise<void>;
}

export interface GoogleJourneyOptions {
  /** The API half's port: the role's API port in a journey run, 0 in a test. */
  readonly apiPort?: number;
  /** The fixture provider's port: its journey port, 0 in a test. */
  readonly providerPort?: number;
}

export async function startGoogleJourneyServers(
  options: GoogleJourneyOptions = {},
): Promise<GoogleJourneyServers> {
  const clientSecret = randomBytes(24).toString("base64url");
  const fixture = new OAuthFixture();
  const provider = await startOAuthFixture(fixture, {
    port: options.providerPort ?? OAUTH_FIXTURE_PORT,
  });
  fixture.registerClient({
    clientId: OAUTH_CLIENT_ID,
    clientSecret,
    redirectUris: [OAUTH_REDIRECT_URI],
  });
  const database = await createTestDatabase("e2e_google");
  const lines: string[] = [];
  let exited: number | null = null;
  const api = await runService(defineConsoleService({ pool: database.login("fin_console") }), {
    env: {
      FIN_SERVICE: "console",
      FIN_ENVIRONMENT: "ci",
      FIN_RELEASE: JOURNEY_RELEASE,
      FIN_DRAIN_SECONDS: "5",
      FIN_PUBLIC_ORIGIN: CONSOLE_ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-public",
      FIN_DOCS_ORIGIN: appOrigin("docs"),
      FIN_INGRESS_PROOFS: JSON.stringify({ console: [testIngressProof("console")] }),
      BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64url")}`,
      FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
      FIN_FEATURE_GOOGLE: "on",
      FIN_GOOGLE_CLIENT_ID: OAUTH_CLIENT_ID,
      FIN_GOOGLE_CLIENT_SECRET: clientSecret,
      FIN_GOOGLE_TEST_ISSUER: provider.origin,
    },
    exit: (code) => {
      exited = code;
    },
    processHandlers: false,
    host: "127.0.0.1",
    port: options.apiPort ?? GOOGLE_JOURNEY_PORTS.api,
    // The static host forwards from loopback: it is the connector in a journey run.
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    stdout: (text) => {
      lines.push(text);
      if (lines.length > 200) lines.shift();
    },
  });
  if (api === undefined) {
    await provider.close();
    await database.drop();
    throw new Error(`the console's API half did not start (exit ${exited}): ${lines.join("\n")}`);
  }
  return {
    provider,
    api,
    database,
    async close() {
      await api.shutdown.begin("SIGTERM");
      await provider.close();
      await database.drop();
    },
  };
}

if (import.meta.main) {
  const servers = await startGoogleJourneyServers();
  process.stdout.write(
    `google-journey: ready (api ${servers.api.port}, provider ${servers.provider.origin})\n`,
  );
  const stop = () => {
    servers.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
