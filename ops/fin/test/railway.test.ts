import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RefusedError } from "../src/core/errors.ts";
import { Masker } from "../src/core/mask.ts";
import { Output } from "../src/core/output.ts";
import { parseOverlay } from "../src/core/overlay.ts";
import { Run } from "../src/core/run.ts";
import { RunLog } from "../src/core/runlog.ts";
import { Secret } from "../src/core/secret.ts";
import { RailwayApi } from "../src/railway/api.ts";
import { fakeRuntime, fakeToken, overlayFixture, tempDir, uuid } from "./helpers/fixtures.ts";
import { FakeRailway } from "./helpers/providers.ts";

const overlay = parseOverlay(overlayFixture(), "staging");

function setup() {
  const token = fakeToken("r");
  const rw = new FakeRailway(token, ["worker", "edge"]);
  const runtime = fakeRuntime({ fetch: rw.fetch });
  const masker = new Masker();
  const run = new Run(
    runtime,
    new RunLog(join(tempDir(), "s"), masker),
    new Output(runtime, masker),
    { command: "test", environment: "staging", dryRun: false },
  );
  run.register();
  const api = new RailwayApi(new Secret(token), runtime, overlay, masker);
  return { rw, run, api };
}

const PATCH =
  "mutation finPatch($environmentId: String!, $patch: EnvironmentConfig, $commitMessage: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage) }";

describe("the Railway client's writes", () => {
  it("sends only the mutations pnpm fin makes, to this environment and the project's services", async () => {
    const { rw, run, api } = setup();
    const worker = await api.serviceId("worker");
    const env = overlay.railway.environmentId;
    const patch = (serviceId: string) => ({ services: { [serviceId]: { variables: {} } } });
    await api.mutate(run, PATCH, { environmentId: env, patch: patch(worker) });
    assert.equal(rw.patches.length, 1);
    const refusals: Array<[string, Record<string, unknown>]> = [
      ["mutation finDrop($id: String!) { serviceDelete(id: $id) }", { id: worker }],
      [
        "mutation finTwo($environmentId: String!) { environmentPatchCommit(environmentId: $environmentId) serviceDelete(id: $environmentId) }",
        { environmentId: env },
      ],
      [PATCH, { environmentId: uuid("e"), patch: patch(worker) }],
      [PATCH, { environmentId: env, patch: patch(uuid("f")) }],
      [
        "mutation finDeploy($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
        { serviceId: uuid("f"), environmentId: env },
      ],
    ];
    for (const [query, variables] of refusals) {
      await assert.rejects(api.mutate(run, query, variables), RefusedError, query);
    }
    assert.equal(rw.patches.length, 1);
    assert.deepEqual(
      rw.operations.filter((op) => op !== "finServices"),
      ["finPatch"],
    );
  });
});
