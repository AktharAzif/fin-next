#!/usr/bin/env node
// The Node a job's checks run on (ci.yml's check and build jobs). A control path. The repository's
// check scripts run their checks only under a main guard, and a Node without import.meta.main
// (before 22.18 and 24.2) reads that guard as "imported": the script exits 0 having checked
// nothing. A pull request chooses its jobs' Node through .node-version, which is not a control
// path, so this step runs before any check script and fails the job on such a Node instead:
// importing lib/ci.mjs throws on a Node older than its floor or without import.meta.main. It
// checks nothing else, and has no main guard, so it can never be skipped by one.
import { NODE_FLOOR, say } from "./lib/ci.mjs";

say(`ci.node version=${process.versions.node} floor=${NODE_FLOOR} result=pass`);
