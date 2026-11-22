// The release images' build steps (ops/docker/*.Dockerfile) and their output scan
// (ops/docker/harness-scan.mjs). Each Dockerfile's release build runs the scan right after its
// build step, in the same RUN and joined by `&&`, over exactly the directory its release stage
// copies into the image, as test/image-build.ts reads them; the RUN itself, run by the
// Dockerfile's shell with a stand-in for pnpm, fails when the scan finds a marker or no output
// and passes when the output is clean. test/image-build.ts reads the environment each Dockerfile
// gives the build step and the script it runs, and refuses a script that is not exactly `vite
// build --config <file>` (a second config file, another step, a pre or post script), a RUN with
// another step or without the scan, and a release stage that copies anything else from the
// repository, however Docker lets the copy name its stage (by index, in quotes, with an escape,
// after another flag) or lets a parent stage bring it in (ONBUILD, a command, a copy). The one
// thing a release stage may take beside its bundle is a copy ops/docker/release-allowlist.json
// names word for word (today the database's files, from app.Dockerfile's db-assets stage), whose
// stage must end in the scan over exactly what it copies; an unlisted copy, the listed one changed,
// or its stage's scan left out, moved or pointed elsewhere is refused, and so is an allowlist of
// any other shape. A `pre` script is read only when it is byte for byte a command the allowlist
// names (the api's generator of the audit event index); that command edited by one byte, any other
// pre-script and every `post` script are refused. It reads
// the Dockerfile's lines as Docker's parser does, and refuses what Docker would read otherwise
// (a parser directive, a heredoc however its lines are continued), a Dockerfile holding any
// character but printable ASCII, tabs and newlines, and one that names two stages alike (Docker
// reads the last stage of a name, where a first match would read the first). The scan itself
// finds each of CI's bundle-check harness rules in a planted output (the fin:test-seam marker, a
// module comment naming packages/testing, as bundle-check's `//#region` and as this build's Vite
// writes it, `// <path>`, an import of the harness's package, packages/testing in a map's sources,
// inline or beside the file), refuses a link and a missing or empty output, and passes an honest
// one.
import { spawnSync } from "node:child_process";
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALLOWLIST_FILE,
  builderFlags,
  type ImageBuild,
  imageBuilds,
  RELEASE_STAGE,
  readAllowlist,
  runHarnessScan,
  SCAN_SCRIPT,
  shellSteps,
  viteBuildConfig,
} from "../../test/image-build.ts";

const REPOSITORY = resolve(import.meta.dirname, "../../../..");
const APP_DOCKERFILE = "ops/docker/app.Dockerfile";
const CONNECTOR_DOCKERFILE = "ops/docker/connector.Dockerfile";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, by its real path (macOS's temporary directory is a link). */
function temporary(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "fin-release-image-")));
  made.push(dir);
  return dir;
}

/** Writes each of `files` (repository path to text) under `root`. */
function writeFiles(root: string, files: ReadonlyMap<string, string>): void {
  for (const [path, text] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/**
 * The files test/image-build.ts reads: the Dockerfiles, their allowlist, the workspace and each
 * app's manifest.
 */
function repositoryFiles(): Map<string, string> {
  const paths = [
    "pnpm-workspace.yaml",
    ALLOWLIST_FILE,
    ...globSync("ops/docker/*.Dockerfile", { cwd: REPOSITORY }),
    ...globSync("apps/*/package.json", { cwd: REPOSITORY }),
  ];
  return new Map(paths.map((path) => [path, readFileSync(join(REPOSITORY, path), "utf8")]));
}

/** A planted repository: the real files test/image-build.ts reads, with `change` applied. */
function plantRepository(change: (files: Map<string, string>) => void): string {
  const files = repositoryFiles();
  change(files);
  const root = temporary();
  writeFiles(root, files);
  return root;
}

/** Replaces `from` with `to` in the file `path` of `files`, which must hold `from` once. */
function replace(files: Map<string, string>, path: string, from: string, to: string): void {
  const text = files.get(path) ?? "";
  if (text.split(from).length !== 2) throw new Error(`${path} does not hold ${from} once`);
  files.set(path, text.replace(from, to));
}

/** Sets the scripts `scripts` (a name to undefined removes it) in the app `app`'s manifest. */
function setScripts(
  files: Map<string, string>,
  app: string,
  scripts: Readonly<Record<string, string | undefined>>,
): void {
  const path = `apps/${app}/package.json`;
  const manifest = JSON.parse(files.get(path) ?? "{}") as { scripts: Record<string, string> };
  for (const [name, command] of Object.entries(scripts)) {
    if (command === undefined) delete manifest.scripts[name];
    else manifest.scripts[name] = command;
  }
  files.set(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

// app.Dockerfile's text: its build step's parts and its release stage's copy of the output.
const APP_RUN_BUILD = `FIN_BUILD_TARGET=release pnpm --filter "@fin/\${APP}" run build:server`;
const APP_RUN_SCAN = `node ${SCAN_SCRIPT} "apps/\${APP}/dist/server"`;
const APP_RUN_CHECK = `test -f "apps/\${APP}/dist/server/main.js"`;
const APP_COPY = `COPY --from=build-release /src/apps/\${APP}/dist/server/ /app/dist/\n`;
// app.Dockerfile's allowlisted copy beside the bundle (ops/docker/release-allowlist.json), which its
// test and release stages both take, and the db-assets stage's scan of what it copies.
const APP_DB_COPY = "COPY --from=db-assets /out/db-assets/ /app/db-assets/\n";
const APP_DB_SCAN = `RUN node ${SCAN_SCRIPT} /out/db-assets\n`;
// The generator the api's build:server runs first, which the allowlist names as its one pre-script.
const AUDIT_GEN = "node ../../packages/audit/src/gen.ts";
// connector.Dockerfile's release stage's copies: cloudflared from its image's stage, and the output.
const CONNECTOR_CLOUDFLARED = "COPY --from=cloudflared ";
const CONNECTOR_COPY = "COPY --from=build /src/apps/connector/dist/server/ /app/dist/\n";

describe("the Dockerfiles' release builds", () => {
  const images = imageBuilds(REPOSITORY);
  const byLabel = new Map(images.builds.map((build) => [build.label, build]));

  it("each run the scan right after the build step, over exactly what the release stage copies", () => {
    expect(images.refusals).toEqual([]);
    expect([...new Set(images.builds.map((build) => build.dockerfile))]).toEqual([
      APP_DOCKERFILE,
      CONNECTOR_DOCKERFILE,
    ]);
    for (const build of images.builds) {
      const steps = shellSteps(build.run, build.environment);
      const at = steps.findIndex((words) => words.includes("pnpm"));
      expect(steps[at + 1]).toEqual(["node", SCAN_SCRIPT, build.output]);
      expect(build.output).toBe(`${build.package}/dist/server`);
    }
  });

  it("read the environment each Dockerfile gives its build step, and the script it runs", () => {
    const api = byLabel.get(`${APP_DOCKERFILE}, APP=api`);
    expect(api?.environment).toEqual({
      TURBO_TELEMETRY_DISABLED: "1",
      CI: "1",
      APP: "api",
      FIN_BUILD_TARGET: "release",
    });
    expect([api?.script, api?.command]).toEqual([
      "build:server",
      "vite build --config vite.server.config.ts",
    ]);
    expect(api?.preScript).toEqual({
      command: AUDIT_GEN,
      writes: "packages/audit/src/events/_index.gen.ts",
    });
    const connector = byLabel.get(CONNECTOR_DOCKERFILE);
    expect(connector?.environment).toEqual({
      TURBO_TELEMETRY_DISABLED: "1",
      CI: "1",
      FIN_BUILD_TARGET: "release",
    });
    expect([connector?.script, connector?.package]).toEqual(["build", "apps/connector"]);
    expect(connector?.preScript).toBeUndefined();
    expect(images.skipped).toContain(
      `${APP_DOCKERFILE}, APP=connector: apps/connector has no build:server script`,
    );
  });

  /**
   * Runs the build step's RUN text by the Dockerfile's shell, in its environment, from a directory
   * standing for the build context's root (the scan and the app's config file in it), with a
   * stand-in for pnpm first on PATH that records its arguments and writes `main` as the build's
   * main.js (nothing when undefined). The RUN's `node` is a link beside the stand-in to the runtime
   * running this test: Node's own binary, or under the Bun canary Bun's, which runs as Node when
   * called by that name (as `bun --bun` runs a script's `node`).
   */
  function runRelease(build: ImageBuild, main: string | undefined) {
    const src = temporary();
    const bin = temporary();
    const files = new Map([
      [SCAN_SCRIPT, readFileSync(join(REPOSITORY, SCAN_SCRIPT), "utf8")],
      [`${build.package}/vite.server.config.ts`, ""],
    ]);
    if (main !== undefined) files.set("planted/main.js", main);
    writeFiles(src, files);
    writeFileSync(
      join(bin, "pnpm"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$PLANTED_ARGS"\n' +
        'if [ -f planted/main.js ]; then mkdir -p "$PLANTED_OUTPUT" && cp planted/main.js "$PLANTED_OUTPUT/"; fi\n',
      { mode: 0o755 },
    );
    symlinkSync(process.execPath, join(bin, "node"));
    const [shell, ...flags] = build.shell;
    const run = spawnSync(shell ?? "/bin/sh", [...flags, build.run], {
      cwd: src,
      encoding: "utf8",
      env: {
        ...build.environment,
        PATH: [bin, "/usr/bin", "/bin"].join(":"),
        PLANTED_ARGS: join(bin, "args"),
        PLANTED_OUTPUT: build.output,
      },
    });
    return {
      status: run.status,
      stderr: run.stderr,
      args: readFileSync(join(bin, "args"), "utf8"),
    };
  }

  it.each([`${APP_DOCKERFILE}, APP=api`, CONNECTOR_DOCKERFILE])(
    "%s: the RUN fails when the scan finds the harness or no output, and passes a clean one",
    (label) => {
      const build = byLabel.get(label);
      if (build === undefined) throw new Error(`no build ${label}`);
      const clean = runRelease(build, "export const planted = 1;\n");
      expect([clean.status, clean.stderr]).toEqual([0, ""]);
      expect(clean.args.trim().split("\n")).toEqual([
        "--filter",
        `@fin/${build.package.split("/")[1]}`,
        "run",
        build.script,
      ]);
      const marked = runRelease(build, "// ../../packages/testing/src/totp.ts\nexport {};\n");
      expect(marked.status).not.toBe(0);
      expect(marked.stderr).toContain(
        `${build.output}/main.js: a module of the test harness (packages/testing) is bundled`,
      );
      const empty = runRelease(build, undefined);
      expect(empty.status).not.toBe(0);
      expect(empty.stderr).toContain("the build left no output");
    },
    30_000,
  );
});

describe("builderFlags", () => {
  it.each([
    ["--from=deps /a /b", ["--from=deps"], "/a /b"],
    ['--link --from="build" /a /b', ["--link", "--from=build"], "/a /b"],
    ["--from='de ps' /a", ["--from=de ps"], "/a"],
    ["--from=de\\ps\t /a", ["--from=deps"], "/a"],
    ['--from="" /a', ["--from="], "/a"],
    ["/a --from=deps /b", [], "/a --from=deps /b"],
    ["--link -- --from=deps /b", ["--link"], " --from=deps /b"],
    ["-x --from=deps /b", [], "-x --from=deps /b"],
  ])("reads %j as Docker's parser does", (text, flags, rest) => {
    expect(builderFlags(text)).toEqual({ flags, rest });
  });
});

describe("viteBuildConfig", () => {
  it("reads exactly `vite build --config <file>`", () => {
    expect(viteBuildConfig({ b: "vite build --config vite.server.config.ts" }, "b")).toBe(
      "vite.server.config.ts",
    );
    expect(viteBuildConfig({ b: "  vite  build --config  sub/x.config.ts " }, "b")).toBe(
      "sub/x.config.ts",
    );
  });

  it.each([
    ["a second config file", "vite build --config a.ts && vite build --config b.ts"],
    ["a step after the build", "vite build --config vite.server.config.ts && node strip.mjs"],
    ["another option", "vite build --config vite.server.config.ts --mode development"],
    ["no config file", "vite build"],
    ["the option's other spelling", "vite build --config=vite.server.config.ts"],
    ["another command", "pnpm run build:bundle"],
    ["a file a shell would expand", "vite build --config $CONFIG"],
    ["a file that reads as an option", "vite build --config -x"],
  ])("refuses %s", (_name, command) => {
    expect(() => viteBuildConfig({ b: command }, "b")).toThrow(
      `its b script, ${JSON.stringify(command)}, is not exactly \`vite build --config <file>\``,
    );
  });

  it.each(["preb", "postb"])("refuses a %s script, which pnpm runs around b", (hook) => {
    expect(() =>
      viteBuildConfig({ b: "vite build --config vite.server.config.ts", [hook]: "true" }, "b"),
    ).toThrow(`the package has a ${hook} script, which pnpm runs with b`);
  });

  it("reads a pre script that is byte for byte an allowed command", () => {
    const scripts = { b: "vite build --config vite.server.config.ts", preb: AUDIT_GEN };
    expect(viteBuildConfig(scripts, "b", [AUDIT_GEN])).toBe("vite.server.config.ts");
  });

  it.each([
    ["another command", "true"],
    ["the allowed command with a byte added", `${AUDIT_GEN} `],
    ["the allowed command with a byte removed", AUDIT_GEN.slice(0, -1)],
    ["the allowed command with a byte changed", AUDIT_GEN.replace("gen.ts", "gen.js")],
    ["a command that is no string", 1],
  ])("refuses a pre script that is %s", (_name, command) => {
    const scripts = { b: "vite build --config vite.server.config.ts", preb: command };
    expect(() => viteBuildConfig(scripts, "b", [AUDIT_GEN])).toThrow(
      "the package has a preb script, which pnpm runs with b",
    );
  });

  it("refuses the allowed command as a post script", () => {
    const scripts = { b: "vite build --config vite.server.config.ts", postb: AUDIT_GEN };
    expect(() => viteBuildConfig(scripts, "b", [AUDIT_GEN])).toThrow(
      "the package has a postb script, which pnpm runs with b",
    );
  });
});

describe("a changed release build is refused, or followed", () => {
  const api = `${APP_DOCKERFILE}, APP=api`;

  it("an app's build:server that runs a second config is refused", () => {
    const command = "vite build --config vite.server.config.ts && vite build --config vite.x.ts";
    const images = imageBuilds(
      plantRepository((files) => setScripts(files, "api", { "build:server": command })),
    );
    expect(images.refusals).toEqual([
      `${api}: its build:server script, ${JSON.stringify(command)}, is not exactly \`vite build --config <file>\``,
    ]);
    expect(images.builds.map((build) => build.label)).not.toContain(api);
  });

  it.each(["prebuild:server", "postbuild:server"])("an app's %s script is refused", (hook) => {
    const images = imageBuilds(
      plantRepository((files) => setScripts(files, "api", { [hook]: "node strip.mjs" })),
    );
    expect(images.refusals).toEqual([
      `${api}: the package has a ${hook} script, which pnpm runs with build:server`,
    ]);
  });

  // The api's prebuild:server is read only because it is byte for byte the allowlisted generator:
  // the same command edited by any one byte, or with a step or a flag added, is refused.
  it.each([
    ["a space added at its end", `${AUDIT_GEN} `],
    ["a space added at its start", ` ${AUDIT_GEN}`],
    ["a tab for a space", AUDIT_GEN.replace(" ", "\t")],
    ["two spaces for one", AUDIT_GEN.replace(" ", "  ")],
    ["a letter in capitals", `N${AUDIT_GEN.slice(1)}`],
    ["a byte removed", AUDIT_GEN.slice(0, -1)],
    ["a byte added to the file's name", `${AUDIT_GEN}x`],
    ["a byte changed in the file's name", AUDIT_GEN.replace("gen.ts", "gen.js")],
    ["another directory", AUDIT_GEN.replace("../../", "../")],
    ["a step after it", `${AUDIT_GEN} && node strip.mjs`],
    ["a flag added", AUDIT_GEN.replace("node ", "node --import ./strip.mjs ")],
  ])("the api's allowlisted prebuild:server with %s is refused", (_name, command) => {
    expect(command).not.toBe(AUDIT_GEN);
    const images = imageBuilds(
      plantRepository((files) => setScripts(files, "api", { "prebuild:server": command })),
    );
    expect(images.refusals).toEqual([
      `${api}: the package has a prebuild:server script, which pnpm runs with build:server`,
    ]);
    expect(images.builds.map((build) => build.label)).not.toContain(api);
  });

  it("the allowlisted generator as an app's postbuild:server is refused", () => {
    const images = imageBuilds(
      plantRepository((files) => setScripts(files, "api", { "postbuild:server": AUDIT_GEN })),
    );
    expect(images.refusals).toEqual([
      `${api}: the package has a postbuild:server script, which pnpm runs with build:server`,
    ]);
  });

  it("the api's prebuild:server is refused once the allowlist no longer names it", () => {
    const images = imageBuilds(
      plantRepository((files) => {
        const allowlist = JSON.parse(files.get(ALLOWLIST_FILE) ?? "{}") as { preScripts: [] };
        allowlist.preScripts = [];
        files.set(ALLOWLIST_FILE, JSON.stringify(allowlist));
      }),
    );
    expect(images.refusals).toEqual([
      `${api}: the package has a prebuild:server script, which pnpm runs with build:server`,
    ]);
  });

  it("the connector's build script, which its Dockerfile runs, is read and refused", () => {
    const images = imageBuilds(
      plantRepository((files) => setScripts(files, "connector", { build: "node bundle.mjs" })),
    );
    expect(images.refusals).toEqual([
      `${CONNECTOR_DOCKERFILE}: its build script, "node bundle.mjs", is not exactly \`vite build --config <file>\``,
    ]);
  });

  it("another config file named by the script is the one built", () => {
    const images = imageBuilds(
      plantRepository((files) =>
        setScripts(files, "api", { "build:server": "vite build --config vite.bundle.config.ts" }),
      ),
    );
    expect(images.refusals).toEqual([]);
    const build = images.builds.find((each) => each.label === api);
    expect(build?.configFile.endsWith("/apps/api/vite.bundle.config.ts")).toBe(true);
  });

  it("another script named by the Dockerfile is the one read", () => {
    const images = imageBuilds(
      plantRepository((files) =>
        replace(
          files,
          APP_DOCKERFILE,
          APP_RUN_BUILD,
          APP_RUN_BUILD.replace("build:server", "build"),
        ),
      ),
    );
    expect(images.refusals).toContain(
      `${api}: its build script, "pnpm run build:server", is not exactly \`vite build --config <file>\``,
    );
  });

  it("an environment the Dockerfile sets reaches the build", () => {
    const images = imageBuilds(
      plantRepository((files) =>
        replace(files, APP_DOCKERFILE, "    CI=1\n", "    CI=1 \\\n    NODE_ENV=development\n"),
      ),
    );
    expect(images.builds.find((build) => build.label === api)?.environment.NODE_ENV).toBe(
      "development",
    );
  });

  it.each([
    [
      "the scan left out",
      APP_DOCKERFILE,
      `    && ${APP_RUN_SCAN} \\\n`,
      "",
      `${api}: its RUN does not run ${SCAN_SCRIPT} over the build's output`,
    ],
    [
      "the scan moved after a later step",
      APP_DOCKERFILE,
      `    && ${APP_RUN_SCAN} \\\n    && ${APP_RUN_CHECK}`,
      `    && ${APP_RUN_CHECK} \\\n    && ${APP_RUN_SCAN}`,
      `${api}: its RUN does not run ${SCAN_SCRIPT} right after the build step`,
    ],
    [
      "the scan over another directory",
      APP_DOCKERFILE,
      APP_RUN_SCAN,
      `node ${SCAN_SCRIPT} "apps/\${APP}/dist"`,
      `${api}: its RUN scans /src/apps/api/dist, but its ${RELEASE_STAGE} stage copies /src/apps/api/dist/server`,
    ],
    [
      "the scan's failure ignored",
      APP_DOCKERFILE,
      `    && ${APP_RUN_SCAN} \\\n`,
      `    && ${APP_RUN_SCAN} || true \\\n`,
      new RegExp(`^${api}: \`test -n .*\` holds \`\\|\`, which the test does not read as a word$`),
    ],
    [
      "a step after the scan",
      APP_DOCKERFILE,
      `    && ${APP_RUN_SCAN} \\\n    && ${APP_RUN_CHECK}`,
      `    && ${APP_RUN_SCAN} \\\n    && ${APP_RUN_CHECK} \\\n    && cp -r packages/testing "apps/\${APP}/dist/server/"`,
      `${api}: its RUN holds a step the test cannot read: \`cp -r packages/testing apps/api/dist/server/\``,
    ],
    [
      "a second RUN in the build stage",
      APP_DOCKERFILE,
      `    && ${APP_RUN_SCAN} \\\n    && ${APP_RUN_CHECK}\n`,
      `    && ${APP_RUN_SCAN} \\\n    && ${APP_RUN_CHECK}\nRUN cp -r packages/testing "apps/\${APP}/dist/server/"\n`,
      `${APP_DOCKERFILE}: its build stage build-release has 2 RUN instructions, not one`,
    ],
    [
      "the release stage copying another directory",
      APP_DOCKERFILE,
      APP_COPY,
      APP_COPY.replace("/dist/server/", "/dist/"),
      `${api}: its RUN scans /src/apps/api/dist/server, but its ${RELEASE_STAGE} stage copies /src/apps/api/dist`,
    ],
    [
      "the release stage copying from the build context",
      APP_DOCKERFILE,
      APP_COPY,
      `${APP_COPY}COPY packages/testing /app/testing\n`,
      new RegExp(
        `^${APP_DOCKERFILE}: its ${RELEASE_STAGE} stage copies from the build context on line \\d+$`,
      ),
    ],
    [
      "the release stage copying a second time from a stage that holds the repository",
      APP_DOCKERFILE,
      APP_COPY,
      `${APP_COPY}COPY --from=deps /src/packages/testing /app/testing\n`,
      `${APP_DOCKERFILE}: its ${RELEASE_STAGE} stage copies 2 times from stages that hold the repository, not once`,
    ],
    [
      "the connector's scan left out",
      CONNECTOR_DOCKERFILE,
      `    && node ${SCAN_SCRIPT} apps/connector/dist/server \\\n`,
      "",
      `${CONNECTOR_DOCKERFILE}: its RUN does not run ${SCAN_SCRIPT} over the build's output`,
    ],
  ] as const)("%s is refused", (_name, dockerfile, from, to, refusal) => {
    const images = imageBuilds(plantRepository((files) => replace(files, dockerfile, from, to)));
    expect(images.refusals).toContainEqual(
      typeof refusal === "string" ? refusal : expect.stringMatching(refusal),
    );
    expect(images.builds.map((build) => build.label)).not.toContain(
      dockerfile === APP_DOCKERFILE ? api : dockerfile,
    );
  });

  it("a stage named by its index, in quotes or in capitals is the stage read", () => {
    const images = imageBuilds(
      plantRepository((files) => {
        // build-release is app.Dockerfile's third stage (index 2), after deps and db-assets.
        replace(files, APP_DOCKERFILE, APP_COPY, APP_COPY.replace("build-release", "2"));
        replace(files, CONNECTOR_DOCKERFILE, CONNECTOR_CLOUDFLARED, "COPY --from=0 ");
        replace(
          files,
          CONNECTOR_DOCKERFILE,
          CONNECTOR_COPY,
          CONNECTOR_COPY.replace("build", '"BUILD"'),
        );
      }),
    );
    expect(images.refusals).toEqual([]);
    const labels = images.builds.map((build) => build.label);
    expect(labels).toContain(api);
    expect(labels).toContain(CONNECTOR_DOCKERFILE);
  });
});

// The one copy app.Dockerfile's release stage takes beside its bundle, the database's files, is read
// only because ops/docker/release-allowlist.json names it word for word, and only while the
// db-assets stage it comes from ends in the image's output scan over exactly what it copies, so
// every copy the release stage takes is scanned. A second copy the allowlist does not name, the
// listed one changed in any word or flag, the stage's scan left out, moved, ignored or pointed
// elsewhere, and an allowlist of any other shape are refused.
describe("the release stage's allowlisted copies", () => {
  const api = `${APP_DOCKERFILE}, APP=api`;
  const twice = `${APP_DOCKERFILE}: its ${RELEASE_STAGE} stage copies 2 times from stages that hold the repository, not once`;
  const stage = `${APP_DOCKERFILE}: its stage db-assets, which ${ALLOWLIST_FILE} lets the ${RELEASE_STAGE} stage copy /out/db-assets/ from,`;
  const unscanned = `${stage} does not end in a RUN whose last step is \`node ${SCAN_SCRIPT} /out/db-assets\``;
  /** app.Dockerfile with its release stage's allowlisted copy replaced by `to`. */
  const releaseCopy = (to: string) => (files: Map<string, string>) =>
    replace(files, APP_DOCKERFILE, `${APP_COPY}${APP_DB_COPY}`, `${APP_COPY}${to}`);
  /** app.Dockerfile with its db-assets stage's scan replaced by `to`. */
  const dbScan = (to: string) => (files: Map<string, string>) =>
    replace(files, APP_DOCKERFILE, APP_DB_SCAN, to);
  /** The allowlist, changed by `change`. */
  const allowlist =
    (change: (value: Record<string, unknown>) => void) => (files: Map<string, string>) => {
      const value = JSON.parse(files.get(ALLOWLIST_FILE) ?? "{}") as Record<string, unknown>;
      change(value);
      files.set(ALLOWLIST_FILE, JSON.stringify(value));
    };
  /** The allowlist's first copy, changed by `change`. */
  const firstCopy = (change: (copy: Record<string, unknown>) => void) =>
    allowlist((value) => {
      const [copy] = value.copies as Record<string, unknown>[];
      if (copy !== undefined) change(copy);
    });

  it("names the database's files and the audit index's generator alone, each with its reason", () => {
    const { copies, preScripts } = readAllowlist(REPOSITORY);
    expect(copies.map((copy) => [copy.stage, copy.source, copy.destination])).toEqual([
      ["db-assets", "/out/db-assets/", "/app/db-assets/"],
    ]);
    expect(preScripts.map((pre) => [pre.command, pre.writes])).toEqual([
      [AUDIT_GEN, "packages/audit/src/events/_index.gen.ts"],
    ]);
    for (const { reason } of [...copies, ...preScripts]) expect(reason.length).toBeGreaterThan(20);
  });

  it("lets the image's db-assets stage's scan pass over the database's files it stages", () => {
    const out = join(temporary(), "db-assets");
    const staged = spawnSync(
      process.execPath,
      [join(REPOSITORY, "packages/db/src/assets-cli.ts"), "stage", out],
      { cwd: REPOSITORY, encoding: "utf8", env: { PATH: dirname(process.execPath) } },
    );
    expect(staged.status).toBe(0);
    const scan = runHarnessScan(REPOSITORY, out);
    expect([scan.status, scan.stderr]).toEqual([0, ""]);
    expect(scan.stdout).toContain("no harness marker");
  }, 30_000);

  it.each<[string, (files: Map<string, string>) => void, string | RegExp]>([
    [
      "a second, unlisted copy from a stage that holds the repository",
      releaseCopy(`${APP_DB_COPY}COPY --from=deps /src/packages/db/ /app/db/\n`),
      twice,
    ],
    [
      "a second, unlisted copy from the allowlisted stage",
      releaseCopy(`${APP_DB_COPY}COPY --from=db-assets /src/packages/testing/ /app/testing/\n`),
      twice,
    ],
    [
      "the listed copy to another destination",
      releaseCopy("COPY --from=db-assets /out/db-assets/ /app/dist/db-assets/\n"),
      twice,
    ],
    [
      "the listed copy from another source",
      releaseCopy("COPY --from=db-assets /src/ /app/db-assets/\n"),
      twice,
    ],
    [
      "the listed copy from another stage",
      releaseCopy("COPY --from=deps /out/db-assets/ /app/db-assets/\n"),
      twice,
    ],
    [
      "the listed copy with another flag",
      releaseCopy("COPY --from=db-assets --chmod=444 /out/db-assets/ /app/db-assets/\n"),
      twice,
    ],
    [
      "the listed copy with a second source",
      releaseCopy("COPY --from=db-assets /out/db-assets/ /src/ /app/db-assets/\n"),
      twice,
    ],
    [
      "the listed copy through a variable",
      releaseCopy("COPY --from=db-assets $FIN_DB_ASSETS_DIR /app/db-assets/\n"),
      twice,
    ],
    [
      "the listed copy once the allowlist no longer names it",
      allowlist((value) => {
        value.copies = [];
      }),
      twice,
    ],
    ["the db-assets stage's scan left out", dbScan(""), unscanned],
    [
      "the db-assets stage's scan over another directory",
      dbScan(`RUN node ${SCAN_SCRIPT} /out\n`),
      unscanned,
    ],
    [
      "the db-assets stage's scan over a directory inside the copy",
      dbScan(`RUN node ${SCAN_SCRIPT} /out/db-assets/packages\n`),
      unscanned,
    ],
    [
      "a step after the db-assets stage's scan",
      dbScan(`RUN node ${SCAN_SCRIPT} /out/db-assets && cp -r packages/testing /out/db-assets/\n`),
      unscanned,
    ],
    [
      "a RUN after the db-assets stage's scan",
      dbScan(`${APP_DB_SCAN}RUN cp -r packages/testing /out/db-assets/\n`),
      unscanned,
    ],
    [
      "an ENV after the db-assets stage's scan",
      dbScan(`${APP_DB_SCAN}ENV NOTE=after\n`),
      unscanned,
    ],
    [
      "a copy into the db-assets stage after its scan",
      dbScan(`${APP_DB_SCAN}COPY packages/testing/ /out/db-assets/testing/\n`),
      new RegExp(`^${stage} has COPY on line \\d+$`),
    ],
    [
      "the db-assets stage's scan's failure ignored",
      dbScan(`RUN node ${SCAN_SCRIPT} /out/db-assets || true\n`),
      new RegExp(
        `^${APP_DOCKERFILE}: \`node .*\` holds \`\\|\`, which the test does not read as a word$`,
      ),
    ],
    [
      "the db-assets stage's scan run with a mount over the copy",
      dbScan(
        `RUN --mount=type=bind,from=deps,source=/src/packages/db,target=/out/db-assets node ${SCAN_SCRIPT} /out/db-assets\n`,
      ),
      new RegExp(`^${stage} has a RUN on line \\d+ that is not a plain shell command$`),
    ],
    [
      "the db-assets stage's scan in exec form",
      dbScan(`RUN ["node", "${SCAN_SCRIPT}", "/out/db-assets"]\n`),
      new RegExp(`^${stage} has a RUN on line \\d+ that is not a plain shell command$`),
    ],
    [
      "an allowlist that is missing",
      (files) => files.delete(ALLOWLIST_FILE),
      `${ALLOWLIST_FILE}: it is missing or is not JSON`,
    ],
    [
      "an allowlist that is not JSON",
      (files) => files.set(ALLOWLIST_FILE, "{"),
      `${ALLOWLIST_FILE}: it is missing or is not JSON`,
    ],
    [
      "an allowlist with a field it does not know",
      allowlist((value) => {
        value.more = [];
      }),
      `${ALLOWLIST_FILE}: it holds about, copies, more, preScripts, not exactly about, copies, preScripts`,
    ],
    [
      "an allowlisted copy without its reason",
      firstCopy((copy) => {
        delete copy.reason;
      }),
      `${ALLOWLIST_FILE}: copy 1 holds destination, source, stage, not exactly stage, source, destination, reason`,
    ],
    [
      "an allowlisted copy whose reason is empty",
      firstCopy((copy) => {
        copy.reason = " ";
      }),
      `${ALLOWLIST_FILE}: copy 1's reason is not a string with text`,
    ],
    [
      "an allowlisted copy from a relative source",
      firstCopy((copy) => {
        copy.source = "out/db-assets/";
      }),
      `${ALLOWLIST_FILE}: copy 1's "out/db-assets/" is not an absolute path in plain characters`,
    ],
    [
      "an allowlisted pre-script that writes outside the repository",
      allowlist((value) => {
        const [pre] = value.preScripts as Record<string, unknown>[];
        if (pre !== undefined) pre.writes = "../outside.ts";
      }),
      `${ALLOWLIST_FILE}: pre-script 1's writes, "../outside.ts", is not a repository path`,
    ],
  ])("refuses %s", (_name, change, refusal) => {
    const images = imageBuilds(plantRepository(change));
    expect(images.refusals).toContainEqual(
      typeof refusal === "string" ? refusal : expect.stringMatching(refusal),
    );
    expect(images.builds.map((build) => build.label)).not.toContain(api);
  });
});

// Each Dockerfile's release stage changed in a way Docker reads one way, which the reader must read
// the same way or refuse: a stage named by its index, in quotes, with an escape or after another
// flag; a --from Docker reads as a source or as the build context; a parent stage's ONBUILD,
// command or copy from a later stage; a stage name used twice, which Docker resolves to the last
// stage of the name; and the lines Docker joins or splits otherwise than a plain reading would (a
// heredoc, split or not, a parser directive, a blank line in a continuation), with any character
// but printable ASCII, tab and newline refused outright (a carriage return or a form feed after a
// line's last escape, a byte-order mark, a Unicode blank after a directive's `#`).
describe.each([
  {
    dockerfile: APP_DOCKERFILE,
    label: `${APP_DOCKERFILE}, APP=api`,
    copy: APP_COPY,
    deps: 0,
    buildStage: "build-release",
  },
  {
    dockerfile: CONNECTOR_DOCKERFILE,
    label: CONNECTOR_DOCKERFILE,
    copy: CONNECTOR_COPY,
    deps: 1,
    buildStage: "build",
  },
])("$dockerfile's release stage, read as Docker reads it", (planted) => {
  const { dockerfile, label, copy, deps, buildStage } = planted;
  /** `text` with `from`, which it must hold once, replaced by `to`. */
  const swap = (text: string, from: string, to: string): string => {
    if (text.split(from).length !== 2) throw new Error(`${dockerfile} does not hold ${from} once`);
    return text.replace(from, () => to);
  };
  const testing = (flags: string) => `COPY ${flags} /src/packages/testing/ /app/testing/\n`;
  /** `lines` after the release stage's copy of the output. */
  const second = (lines: string) => (text: string) => swap(text, copy, `${copy}${lines}`);
  /** The release stage built on `runtime`, a stage of `lines` on the release stage's own image. */
  const parent = (lines: string) => (text: string) =>
    swap(text, " AS release\n", ` AS runtime\n${lines}FROM runtime AS release\n`);
  const twice = `its ${RELEASE_STAGE} stage copies 2 times from stages that hold the repository, not once`;
  const builtOn = `its ${RELEASE_STAGE} stage is built on runtime, which holds the repository`;
  const context = new RegExp(
    `^its ${RELEASE_STAGE} stage copies from the build context on line \\d+$`,
  );
  /** The refusal of a stage name used twice. */
  const again = (name: string) =>
    new RegExp(
      `^FROM on line \\d+ names the stage ${name} again \\(the FROM on line \\d+ names it first\\), which the test refuses: Docker would read the last stage of a name$`,
    );
  /** The refusal of the character `code` (U+XXXX), on line `line` when given. */
  const outside = (code: string, line?: number) =>
    new RegExp(
      `^line ${line ?? "\\d+"} holds U\\+${code}, a character outside printable ASCII, tab and newline, which the test does not read$`,
    );
  const heredoc =
    /^the instruction on line \d+ holds a heredoc \(`<<`\), which the test does not read$/;

  it.each<[string, (text: string) => string, string | RegExp]>([
    ["a second copy that names a stage by its index", second(testing(`--from=${deps}`)), twice],
    [
      "a second copy that names a stage by a signed index",
      second(testing(`--from=+0${deps}`)),
      twice,
    ],
    ["a second copy that names a stage in quotes", second(testing('--from="deps"')), twice],
    ["a second copy that names a stage in capitals", second(testing("--from='DePs'")), twice],
    ["a second copy that names a stage with an escape", second(testing("--from=de\\ps")), twice],
    [
      "a second copy whose --from follows another flag",
      second(testing("--link --from=deps")),
      twice,
    ],
    [
      "a parent stage's ONBUILD",
      parent(`ONBUILD ${testing("--from=deps")}`),
      /^ONBUILD on line \d+ gives instructions to the stages built on its own, which the test does not read$/,
    ],
    [
      "a parent stage that mounts the repository by a later flag",
      parent("RUN --network=none --mount=type=bind,from=deps,target=/r cp -r /r/packages /app/\n"),
      builtOn,
    ],
    ["a parent stage that runs a command", parent("RUN wget https://example.org/x.js\n"), builtOn],
    [
      "a parent stage that copies from a stage after it",
      (text) =>
        swap(
          text,
          " AS release\n",
          ` AS runtime\n${testing("--from=late")}FROM deps AS late\nFROM runtime AS release\n`,
        ),
      builtOn,
    ],
    [
      "a copy whose empty --from is the build context",
      second('COPY --from="" packages/testing/ /app/testing/\n'),
      context,
    ],
    [
      "a --from after a source, which Docker reads as a source",
      second("COPY packages/testing/ --from=deps* /app/testing/\n"),
      context,
    ],
    [
      "a copy from an image not pinned by digest",
      second(testing("--from=node:26")),
      /^COPY on line \d+ copies from "node:26", which is neither a stage of the file nor an image pinned by digest$/,
    ],
    [
      "a copy from a stage index the file does not have",
      second(testing("--from=9")),
      /^COPY on line \d+ copies from "9", which is neither a stage of the file nor an image pinned by digest$/,
    ],
    [
      "a copy whose --from is a variable",
      second(testing("--from=$APP")),
      /^COPY on line \d+ gives --from as "\$APP", which the test does not read$/,
    ],
    [
      "a copy that gives --from twice",
      second(testing(`--from=deps --from=${deps}`)),
      /^COPY on line \d+ gives --from 2 times$/,
    ],
    [
      "a heredoc, whose lines Docker reads as a file's text",
      second(`COPY <<EOF /app/notes.txt\nFROM scratch AS notes\nEOF\n${testing("--from=deps")}`),
      heredoc,
    ],
    [
      "a heredoc whose `<<` is split over a continued line, which Docker joins first",
      second(
        `COPY --from=${deps} <\\\n<EOF /app/NOTICE\nFROM scratch AS notes\nEOF\n${testing("--from=deps")}`,
      ),
      heredoc,
    ],
    [
      "a blank line in a continued instruction, which Docker skips",
      second(`CMD ["x"] \\\n\nFROM scratch AS notes\n${testing("--from=deps")}`),
      twice,
    ],
    [
      "a form feed after a line's last escape",
      second(`CMD ["x"] \\\f\n${testing("--from=deps")}`),
      outside("000C"),
    ],
    [
      "two carriage returns after a line's last escape, which Docker trims and continues",
      second(`ENV NOTE keep \\\r\r\nFROM deps AS extras\n${testing("--from=deps")}`),
      outside("000D"),
    ],
    [
      "a Dockerfile whose lines end in a carriage return",
      (text) => text.replaceAll("\n", "\r\n"),
      outside("000D", 1),
    ],
    [
      "a line that ends in an escaped escape",
      second(`CMD ["x"] \\\\\n${testing("--from=deps")}`),
      /^line \d+ ends in an escaped escape, which the test does not read$/,
    ],
    [
      "a line that begins with a byte-order mark, which Docker reads as no comment",
      second(`CMD ["x"] \\\n\uFEFF# a note\n${testing("--from=deps")}`),
      outside("FEFF"),
    ],
    [
      "a syntax directive with a no-break space after its #, which Docker reads as a directive",
      (text) => `#\u00A0syntax=example.org/frontend\n${text}`,
      outside("00A0", 1),
    ],
    [
      "an escape directive with a next-line character after its #",
      (text) => `#\u0085escape=\`\n${text}`,
      outside("0085", 1),
    ],
    ["a character outside ASCII in a comment", second("# A note \u2014 kept.\n"), outside("2014")],
    [
      "a character outside ASCII in an instruction",
      second("LABEL note=caf\u00E9\n"),
      outside("00E9"),
    ],
    [
      "a later stage that reuses the build stage's name, whose output Docker's copy reads",
      (text) =>
        `${text}FROM deps AS ${buildStage}\nRUN FIN_BUILD_TARGET=test pnpm --filter @fin/api run build:server\n`,
      again(buildStage),
    ],
    [
      "a later stage named release, which Docker's --target builds",
      (text) => `${text}FROM deps AS Release\n`,
      again(RELEASE_STAGE),
    ],
    [
      "a stage that reuses the build stage's parent's name",
      (text) =>
        swap(
          text,
          `FROM deps AS ${buildStage}\n`,
          `FROM deps AS deps\nRUN rm -rf packages/server\nFROM deps AS ${buildStage}\n`,
        ),
      again("deps"),
    ],
    [
      "a stage named by a number, which Docker refuses and the reader uses for unnamed stages",
      (text) => `${text}FROM deps AS 0\n`,
      /^FROM on line \d+ names its stage "0", which Docker refuses as a stage's name$/,
    ],
    [
      "an escape directive",
      (text) => `# escape=\`\n${text}`,
      /^line 1 is a parser directive, which changes how Docker reads the file$/,
    ],
    [
      "a syntax directive among the first comments",
      (text) => `# A note.\n\n  #SYNTAX = example.org/frontend\n${text}`,
      /^line 3 is a parser directive, which changes how Docker reads the file$/,
    ],
  ])("refuses %s", (_name, change, refusal) => {
    const images = imageBuilds(
      plantRepository((files) => files.set(dockerfile, change(files.get(dockerfile) ?? ""))),
    );
    const prefix = `${dockerfile}: `;
    const refusals = images.refusals
      .filter((each) => each.startsWith(prefix))
      .map((each) => each.slice(prefix.length));
    expect(refusals).toContainEqual(
      typeof refusal === "string" ? refusal : expect.stringMatching(refusal),
    );
    expect(images.builds.map((build) => build.label)).not.toContain(label);
  });
});

describe("harness-scan.mjs", () => {
  const map = (sources: string[]) => JSON.stringify({ version: 3, sources, mappings: "" });
  const inline = (sources: string[]) =>
    `export {};\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map(sources)).toString("base64")}\n`;
  /** A planted output: each of `files` (a path in it to its text) written under a new directory. */
  const output = (files: Readonly<Record<string, string>>): string => {
    const dir = temporary();
    writeFiles(dir, new Map(Object.entries(files)));
    return dir;
  };
  // An honest bundle as this build's Vite writes one (a `// <path>` comment before each module's
  // code), with a `//#region` as bundle-check reads one, a comment that names the harness's
  // directory in a sentence, and a string that names another package's testing subpath.
  const HONEST = {
    "main.js":
      '// ../../packages/core/src/clock.ts\nimport { createServer } from "node:http";\n' +
      "// packages/testing/ holds the harness, which only the test target bundles.\n" +
      '//#region src/server.node.ts\nconst name = "@fin/server/testing";\n' +
      "export { createServer, name };\n//#endregion\n//# sourceMappingURL=main.js.map\n",
    "main.js.map": map(["../../src/server.node.ts", "../../../../packages/server/src/index.ts"]),
    "assets/worker-x.js": "self.onmessage = () => {};\n",
  };

  it("passes an honest output", () => {
    const scan = runHarnessScan(REPOSITORY, output(HONEST));
    expect([scan.status, scan.stderr]).toEqual([0, ""]);
    expect(scan.stdout).toContain("3 file(s), no harness marker");
  }, 30_000);

  it.each([
    [
      "the fin:test-seam marker",
      "main.js",
      'const seam = "fin:test-seam";\n',
      "a test seam's marker (fin:test-seam)",
    ],
    [
      "a module of packages/testing, as this build's Vite names one",
      "main.js",
      "// ../../packages/testing/src/totp.ts\nfunction totp() {}\n",
      "a module of the test harness (packages/testing) is bundled",
    ],
    [
      "a region of packages/testing, as bundle-check reads one",
      "main.js",
      "//#region ../../packages/testing/src/totp.ts\nfunction totp() {}\n//#endregion\n",
      "a module of the test harness (packages/testing) is bundled",
    ],
    [
      "a module of the harness through its package's link",
      "main.js",
      "//#region ../../node_modules/@fin/testing/src/totp.ts\n",
      "a module of the test harness (packages/testing) is bundled",
    ],
    [
      "a static import of the harness's package",
      "main.js",
      'import { totp } from "@fin/testing";\n',
      "the test harness's package (@fin/testing) is imported",
    ],
    [
      "a side-effect import of a subpath",
      "main.js",
      "import '@fin/testing/http';\n",
      "the test harness's package (@fin/testing) is imported",
    ],
    [
      "a dynamic import",
      "main.js",
      'const h = await import( "@fin/testing" );\n',
      "the test harness's package (@fin/testing) is imported",
    ],
    [
      "a require call",
      "main.cjs",
      'const h = require("@fin/testing/totp");\n',
      "the test harness's package (@fin/testing) is imported",
    ],
    [
      "a marker in an asset beside the bundle",
      "assets/totp-1a2b.ts",
      "// ../../packages/testing/src/totp.ts\n",
      "a module of the test harness (packages/testing) is bundled",
    ],
    [
      "packages/testing in a map's sources",
      "main.js.map",
      map(["../../src/server.node.ts", "../../../../packages/testing/src/totp.ts"]),
      "a map names a file of the test harness (packages/testing) in its sources",
    ],
    [
      "the harness's package link in a map's sources",
      "assets/w.js.map",
      map(["../../node_modules/@fin/testing/src/totp.ts"]),
      "a map names a file of the test harness (packages/testing) in its sources",
    ],
    [
      "packages/testing in an inline map's sources",
      "main.js",
      inline(["../../packages/testing/src/clock.ts"]),
      "an inline map names a file of the test harness (packages/testing) in its sources",
    ],
    ["a map that is not one", "main.js.map", "not json", "a map that is not a source map"],
  ])(
    "finds %s",
    (_name, file, text, what) => {
      const dir = output({ ...HONEST, [file]: text });
      const scan = runHarnessScan(REPOSITORY, dir);
      expect(scan.status).toBe(1);
      expect(scan.stderr.split("\n")).toContain(`harness-scan: ${dir}/${file}: ${what}`);
      expect(scan.stderr).toContain("the release output holds the test harness");
    },
    30_000,
  );

  it("refuses a link in the output, never following it", () => {
    const dir = output(HONEST);
    symlinkSync(join(REPOSITORY, "packages/testing"), join(dir, "testing"), "dir");
    const scan = runHarnessScan(REPOSITORY, dir);
    expect(scan.status).toBe(1);
    expect(scan.stderr).toContain(
      `harness-scan: ${dir}/testing: a link, which the image would copy as a link`,
    );
  }, 30_000);

  it("refuses an output that is missing, not a directory or empty", () => {
    const dir = temporary();
    expect(runHarnessScan(REPOSITORY, join(dir, "missing"))).toMatchObject({ status: 2 });
    writeFileSync(join(dir, "file"), "");
    expect(runHarnessScan(REPOSITORY, join(dir, "file"))).toMatchObject({ status: 2 });
    mkdirSync(join(dir, "empty"));
    const empty = runHarnessScan(REPOSITORY, join(dir, "empty"));
    expect([empty.status, empty.stderr.trim()]).toEqual([
      2,
      `harness-scan: ${join(dir, "empty")} holds no file`,
    ]);
  }, 30_000);
});
