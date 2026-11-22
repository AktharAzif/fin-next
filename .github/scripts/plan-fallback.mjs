#!/usr/bin/env node
// The plan before main holds fin-review's engine (spec 01 §5.3; spec 07 §10.1). A control path.
// ci.yml's plan job runs `node engine/tools/fin-review/src/main.ts plan --ci` from main's copy when
// main has it; until then it runs this, which plans everything: every job runs. It prints one
// `plan=<one-line JSON>` line for $GITHUB_OUTPUT, in the engine's document shape, with reason
// `no_engine`. The gate does not trust this document: without the engine on main it needs every
// job whatever the plan says (gate.mjs, rule plan-is-mains).
//
// Inputs (environment): EVENT_NAME, BASE_SHA, HEAD_SHA, as the engine reads them.
import { isMain, isSha, say, ZERO_SHA } from "./lib/ci.mjs";

/** The e2e shard count the engine's config/ci.json starts at (spec 07 §10.4). */
export const E2E_SHARDS = 4;

/**
 * The everything plan for an event.
 * @param {NodeJS.ProcessEnv} env
 */
export function everythingPlan(env) {
  const event = /^[a-z][a-z_]{0,39}$/.test(env.EVENT_NAME ?? "") ? String(env.EVENT_NAME) : "local";
  const base = isSha(env.BASE_SHA) && env.BASE_SHA !== ZERO_SHA ? env.BASE_SHA : null;
  const head = isSha(env.HEAD_SHA) ? env.HEAD_SHA : null;
  return {
    v: 1,
    event,
    base,
    head,
    tier: "S",
    changed: 0,
    classes: [],
    everything: true,
    reason: "no_engine",
    jobs: {
      check: true,
      db: true,
      build: true,
      seams: true,
      e2e: true,
      e2e_shards: E2E_SHARDS,
      static: true,
      bun: true,
      review: false,
      selfTest: true,
      containers: true,
    },
    e2e: { apps: [], projects: [], shards: E2E_SHARDS },
    packages: null,
    images: [],
    static: [],
    layout: "missing",
  };
}

if (isMain(import.meta)) {
  say(`plan=${JSON.stringify(everythingPlan(process.env))}`);
}
