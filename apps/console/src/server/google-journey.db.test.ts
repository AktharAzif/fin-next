// The servers Google's journey runs behind the static host (apps/console/test/google-journey.ts),
// started on free ports: the console's API half answers as the static host's tunnel reaches it
// (from loopback, the console host's name, the test ingress proof) with Google on, and the fixture
// provider answers its key set. The browser half of the journey is apps/console/e2e/google/.

import { rawRequest } from "@fin/server/testing/http";
import { appOrigin, testIngressProof } from "@fin/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GoogleJourneyServers, startGoogleJourneyServers } from "../../test/google-journey.ts";

let servers: GoogleJourneyServers;

beforeAll(async () => {
  servers = await startGoogleJourneyServers({ apiPort: 0, providerPort: 0 });
});

afterAll(async () => {
  await servers?.close();
});

describe("Google's journey servers", () => {
  it("serve the API half with Google on, as the static host's tunnel reaches it", async () => {
    const host = new URL(appOrigin("console")).host;
    const answer = await rawRequest({
      port: servers.api.port,
      address: "127.0.0.1",
      path: "/api/sign-in/methods",
      headers: { host, "fin-ingress-proof": testIngressProof("console") },
    });
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ google: true });
    // Without the proof, the tunnel's check refuses it.
    const unproved = await rawRequest({
      port: servers.api.port,
      address: "127.0.0.1",
      path: "/api/sign-in/methods",
      headers: { host },
    });
    expect(unproved.status).toBe(403);
  });

  it("serve the fixture provider's keys", async () => {
    const keys = await fetch(`${servers.provider.origin}/jwks`);
    expect(keys.status).toBe(200);
    expect(((await keys.json()) as { keys: unknown[] }).keys).toHaveLength(1);
  });
});
