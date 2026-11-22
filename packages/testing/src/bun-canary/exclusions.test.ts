import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUN_CANARY_EXCLUSIONS,
  type BunCanaryExclusion,
  bunCanaryExclusion,
  bunCanaryExclusionLine,
  staleBunCanaryExclusions,
} from "./exclusions.ts";

const REPOSITORY = resolve(import.meta.dirname, "../../../..");

const LIST: readonly BunCanaryExclusion[] = [
  { file: "packages/a/src/x.test.ts", test: "group > does one thing", reason: "Bun differs here" },
  { file: "packages/a/src/x.test.ts", test: "group > does another", reason: "and here" },
];

describe("the Bun canary's exclusions", () => {
  it("name each test by its file and exact full name, with a reason, once", () => {
    const keys = new Set<string>();
    for (const entry of BUN_CANARY_EXCLUSIONS) {
      expect(existsSync(resolve(REPOSITORY, entry.file)), entry.file).toBe(true);
      expect(entry.file, entry.file).toMatch(/^(packages|apps|ops|tools)\/[^\\]+\.test\.tsx?$/);
      expect(entry.test.trim(), entry.file).not.toBe("");
      expect(entry.reason.trim(), entry.test).not.toBe("");
      keys.add(`${entry.file}\n${entry.test}`);
    }
    expect(keys.size).toBe(BUN_CANARY_EXCLUSIONS.length);
  });

  it("list today's three, as the steward ruled on 22 Nov", () => {
    expect(BUN_CANARY_EXCLUSIONS.map((entry) => [entry.file, entry.test])).toEqual([
      [
        "packages/server/src/http/serve.test.ts",
        "startHttpServer > answers what the adapter cannot parse through the front door, inside the request unit",
      ],
      [
        "packages/server/src/build/release-image.test.ts",
        "the Dockerfiles' release builds > ops/docker/app.Dockerfile, APP=api: the RUN fails when the scan finds the harness or no output, and passes a clean one",
      ],
      [
        "packages/server/src/build/release-image.test.ts",
        "the Dockerfiles' release builds > ops/docker/connector.Dockerfile: the RUN fails when the scan finds the harness or no output, and passes a clean one",
      ],
    ]);
    expect(BUN_CANARY_EXCLUSIONS[0]?.reason).toContain(
      "Bun's own HTTP server answers `GET *` before the adapter",
    );
    for (const entry of BUN_CANARY_EXCLUSIONS.slice(1)) {
      expect(entry.reason).toContain(
        "no `node` in the Bun canary for the Dockerfile step the test runs",
      );
    }
  });

  it("match a test only by its exact file and full name", () => {
    expect(bunCanaryExclusion("packages/a/src/x.test.ts", "group > does one thing", LIST)).toBe(
      LIST[0],
    );
    for (const [file, test] of [
      ["packages/a/src/x.test.ts", "group > does one"],
      ["packages/a/src/x.test.ts", "group > does one thing too"],
      ["packages/a/src/x.test.ts", "does one thing"],
      ["packages/a/src/x.test.ts", "Group > does one thing"],
      ["packages/a/src/y.test.ts", "group > does one thing"],
      ["a/src/x.test.ts", "group > does one thing"],
    ] as const) {
      expect(bunCanaryExclusion(file, test, LIST), `${file} ${test}`).toBeUndefined();
    }
  });

  it("find the entries that name a test their file no longer has", () => {
    const file = "packages/a/src/x.test.ts";
    expect(staleBunCanaryExclusions(file, new Set(LIST.map((e) => e.test)), LIST)).toEqual([]);
    expect(staleBunCanaryExclusions(file, new Set(["group > does another"]), LIST)).toEqual([
      LIST[0],
    ]);
    expect(staleBunCanaryExclusions("packages/a/src/other.test.ts", new Set(), LIST)).toEqual([]);
  });

  it("say in one log line what is excluded and why", () => {
    const line = bunCanaryExclusionLine({
      file: "packages/a/src/x.test.ts",
      test: 'group > says "hi"',
      reason: "Bun differs",
    });
    expect(line).toBe(
      'bun.canary.excluded file=packages/a/src/x.test.ts test="group > says \\"hi\\"" reason="Bun differs"\n',
    );
  });
});
