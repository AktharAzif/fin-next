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
// names word for word for its Dockerfile (today the database's files, from app.Dockerfile's
// db-assets stage), whose stage must be exactly the command the allowlist names as making it and
// then the scan in its database files' mode over exactly what it copies, built on the bundle's
// build stage's parent and run where that stage runs pnpm; an unlisted copy, the listed one
// changed or in another Dockerfile, its stage's scan left out, moved, pointed elsewhere or in the
// bundle's mode, any other step or instruction of its stage, before the scan or after it, or
// another parent or directory is refused, and so is an allowlist of any other shape; and that
// command stages nothing but the files of packages/db/src/assets.ts's rule. The stages under the
// bundle's build stage (deps) are held to the pinned base, word for word (a RUN, a step, an ENV, an
// ARG, an ADD or a COPY planted there is refused, and so is a base image that is not Node's by
// digest and a workspace script pnpm's install runs), and the release stage starts nothing but its
// bundle (no ENTRYPOINT, HEALTHCHECK or NODE_* ENV, and one CMD of known flags and main.js). Each of
// the variants of the steward's ruling of 22 Nov on the db-assets copy is shown refused by the
// reader, by the scan of the stage's output, or by both. A `pre` script is read only when it is byte for byte a command
// the allowlist names (the api's generator of the audit event index); that command edited by one
// byte, any other pre-script and every `post` script are refused. It reads the Dockerfile's lines
// as Docker's parser does, and refuses what Docker would read otherwise (a parser directive, a
// heredoc however its lines are continued), a Dockerfile holding any character but printable
// ASCII, tabs and newlines, and one that names two stages alike (Docker reads the last stage of a
// name, where a first match would read the first). The scan itself
// finds each harness rule of CI's bundle check (which returns with the tokenizer PR) in a planted
// output (the fin:test-seam marker, a module comment naming packages/testing, as the bundle check's
// `//#region` and as this build's Vite writes it, `// <path>`, an import of the harness's package,
// packages/testing in a map's sources, inline or beside the file), refuses a link and a missing or
// empty output, and passes an honest one; in its database files' mode it also refuses every file
// but a .sql or .json file in the database's folders, any path containing packages/testing and any
// directory outside those folders, and passes the database's files.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALLOWLIST_FILE,
  builderFlags,
  DB_ASSETS_SCAN,
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

/** `text` with its regular expression's special characters escaped. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
const APP_DB_SCAN_STEP = `node ${SCAN_SCRIPT} ${DB_ASSETS_SCAN} /out/db-assets`;
const APP_DB_SCAN = `RUN ${APP_DB_SCAN_STEP}\n`;
// The db-assets stage's staging command, the command the allowlisted copy names as what makes it.
const DB_STAGE_COMMAND = "node packages/db/src/assets-cli.ts stage /out/db-assets";
const APP_DB_PRODUCE = `RUN ${DB_STAGE_COMMAND}\n`;
// The database's files by packages/db/src/assets.ts's rule, from the repository's root.
const DB_ASSET_RULE = [
  "packages/*/bootstrap/*.sql",
  "packages/*/migrations/*.sql",
  "packages/*/grants/*.json",
  "packages/db/roles/grants/*.json",
];
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
   * main.js (nothing when undefined).
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
    const [shell, ...flags] = build.shell;
    const run = spawnSync(shell ?? "/bin/sh", [...flags, build.run], {
      cwd: src,
      encoding: "utf8",
      env: {
        ...build.environment,
        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
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

  // The stages under the build stage are the pinned base, whose ENV is its two names alone (an ENV
  // planted there is refused: "the stages the bundle's build stage is built on"), so the build
  // stage's own ENV is the one that may set more.
  it("an environment the Dockerfile sets reaches the build", () => {
    const images = imageBuilds(
      plantRepository((files) =>
        replace(
          files,
          APP_DOCKERFILE,
          "FROM deps AS build-release\nARG APP\n",
          "FROM deps AS build-release\nARG APP\nENV NODE_ENV=development\n",
        ),
      ),
    );
    expect(images.refusals).toEqual([]);
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
// only because ops/docker/release-allowlist.json names it word for word, for that Dockerfile, and
// only while the db-assets stage it comes from is exactly the command the allowlist names as making
// it and then the image's output scan in its database files' mode over exactly what it copies,
// built on the stage the bundle's build stage is built on (held to the pinned base) and run where
// that stage runs pnpm, so nothing of the stage's own comes before the scan but that command, and
// the scan fails the build on anything but the database's files. A second copy the allowlist does
// not name, the listed one changed in any word or flag or taken in another Dockerfile, the stage's
// scan left out, moved, ignored, pointed elsewhere or in the bundle's mode, any other step or
// instruction in the stage (before the scan too: a copy of the harness, a second build, a cd, an
// ARG, ENV, WORKDIR or SHELL of its own), the staging command changed, another parent or another
// directory, and an allowlist of any other shape are refused. The command the allowlist names
// stages nothing but the files of packages/db/src/assets.ts's rule, byte for byte, and none of
// packages/testing, and the scan passes them.
describe("the release stage's allowlisted copies", () => {
  const api = `${APP_DOCKERFILE}, APP=api`;
  const twice = `${APP_DOCKERFILE}: its ${RELEASE_STAGE} stage copies 2 times from stages that hold the repository, not once`;
  const which = `its stage db-assets, which ${ALLOWLIST_FILE} lets the ${RELEASE_STAGE} stage copy /out/db-assets/ from,`;
  const stage = `${APP_DOCKERFILE}: ${which}`;
  const unscanned = `${stage} does not end in a RUN whose last step is \`${APP_DB_SCAN_STEP}\``;
  const exactly = `${stage} does not run exactly \`${DB_STAGE_COMMAND}\` and then \`${APP_DB_SCAN_STEP}\`, with no other step`;
  /** The refusal of an instruction `keyword` of the db-assets stage's own. */
  const own = (keyword: string) => new RegExp(`^${stage} has ${keyword} on line \\d+$`);
  /** app.Dockerfile with its release stage's allowlisted copy replaced by `to`. */
  const releaseCopy = (to: string) => (files: Map<string, string>) =>
    replace(files, APP_DOCKERFILE, `${APP_COPY}${APP_DB_COPY}`, `${APP_COPY}${to}`);
  /** app.Dockerfile with its db-assets stage's scan replaced by `to`. */
  const dbScan = (to: string) => (files: Map<string, string>) =>
    replace(files, APP_DOCKERFILE, APP_DB_SCAN, to);
  /** app.Dockerfile with its db-assets stage's instructions (its staging and its scan) replaced. */
  const dbStage = (to: string) => (files: Map<string, string>) =>
    replace(files, APP_DOCKERFILE, `${APP_DB_PRODUCE}${APP_DB_SCAN}`, to);
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
    expect(
      copies.map((copy) => [
        copy.dockerfile,
        copy.stage,
        copy.source,
        copy.destination,
        copy.produces,
      ]),
    ).toEqual([
      [APP_DOCKERFILE, "db-assets", "/out/db-assets/", "/app/db-assets/", DB_STAGE_COMMAND],
    ]);
    expect(preScripts.map((pre) => [pre.command, pre.writes])).toEqual([
      [AUDIT_GEN, "packages/audit/src/events/_index.gen.ts"],
    ]);
    for (const { reason } of [...copies, ...preScripts]) expect(reason.length).toBeGreaterThan(20);
  });

  // The allowlisted command, run as the stage runs it with the copy's source a temporary directory,
  // stages exactly the files of assets.ts's rule in the source tree, each byte for byte, and nothing
  // else (packages/db's assets.test.ts holds that rule's files equal to discoverDbAssets's, and the
  // scan's database files' mode equal to that rule); and the image's scan, in that mode as the stage
  // runs it, passes over them. What the scan refuses in that mode is in "harness-scan.mjs".
  it("stages by the allowlisted command nothing but the database's files, which the scan passes", () => {
    const [entry, ...more] = readAllowlist(REPOSITORY).copies;
    if (entry === undefined || more.length > 0) throw new Error("the allowlist names not one copy");
    const [node, ...args] = shellSteps(entry.produces, {})[0] ?? [];
    expect(node).toBe("node");
    const source = posix.resolve(entry.source);
    expect(args.filter((word) => word === source)).toHaveLength(1);
    const out = join(temporary(), "db-assets");
    const staged = spawnSync(
      process.execPath,
      args.map((word) => (word === source ? out : word)),
      { cwd: REPOSITORY, encoding: "utf8", env: { PATH: dirname(process.execPath) } },
    );
    expect([staged.status, staged.stderr]).toEqual([0, ""]);
    const files = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((each) => !each.isDirectory())
      .map((each) => relative(out, join(each.parentPath, each.name)).split(sep).join("/"))
      .sort();
    const rule = globSync(DB_ASSET_RULE, { cwd: REPOSITORY })
      .map((path) => path.split(sep).join("/"))
      .sort();
    expect(rule.length).toBeGreaterThan(0);
    expect(files).toEqual(rule);
    expect(files.filter((file) => file.startsWith("packages/testing/"))).toEqual([]);
    for (const file of files) {
      expect(readFileSync(join(out, file)).equals(readFileSync(join(REPOSITORY, file))), file).toBe(
        true,
      );
    }
    const scan = runHarnessScan(REPOSITORY, out, [DB_ASSETS_SCAN]);
    expect([scan.status, scan.stderr]).toEqual([0, ""]);
    expect(scan.stdout).toContain(
      `${files.length} file(s), the database's files only, no harness marker`,
    );
  }, 30_000);

  it("reads the staging command and the scan joined in one RUN", () => {
    const images = imageBuilds(
      plantRepository(dbStage(`RUN ${DB_STAGE_COMMAND} && ${APP_DB_SCAN_STEP}\n`)),
    );
    expect(images.refusals).toEqual([]);
    expect(images.builds.map((build) => build.label)).toContain(api);
  });

  // The allowlist names the copy for app.Dockerfile: the same copy taken in connector.Dockerfile,
  // from a stage of the same name that stages and scans it as app.Dockerfile's does, is a second
  // copy from a stage that holds the repository there.
  it("refuses the listed copy in another Dockerfile, from a stage that stages and scans it", () => {
    const images = imageBuilds(
      plantRepository((files) => {
        replace(
          files,
          CONNECTOR_DOCKERFILE,
          "FROM deps AS build\n",
          `FROM deps AS db-assets\n${APP_DB_PRODUCE}${APP_DB_SCAN}\nFROM deps AS build\n`,
        );
        replace(files, CONNECTOR_DOCKERFILE, CONNECTOR_COPY, `${CONNECTOR_COPY}${APP_DB_COPY}`);
      }),
    );
    expect(images.refusals).toEqual([
      `${CONNECTOR_DOCKERFILE}: its ${RELEASE_STAGE} stage copies 2 times from stages that hold the repository, not once`,
    ]);
    const labels = images.builds.map((build) => build.label);
    expect(labels).not.toContain(CONNECTOR_DOCKERFILE);
    expect(labels).toContain(api);
  });

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
      "the db-assets stage's scan in the bundle's mode, which reads markers alone",
      dbScan(`RUN node ${SCAN_SCRIPT} /out/db-assets\n`),
      unscanned,
    ],
    [
      "the db-assets stage's scan with its mode's flag after the directory",
      dbScan(`RUN node ${SCAN_SCRIPT} /out/db-assets ${DB_ASSETS_SCAN}\n`),
      unscanned,
    ],
    [
      "the db-assets stage's scan with another flag before its mode's",
      dbScan(`RUN node ${SCAN_SCRIPT} --bundle ${DB_ASSETS_SCAN} /out/db-assets\n`),
      unscanned,
    ],
    [
      "the db-assets stage's scan over another directory",
      dbScan(`RUN node ${SCAN_SCRIPT} ${DB_ASSETS_SCAN} /out\n`),
      unscanned,
    ],
    [
      "the db-assets stage's scan over a directory inside the copy",
      dbScan(`RUN node ${SCAN_SCRIPT} ${DB_ASSETS_SCAN} /out/db-assets/packages\n`),
      unscanned,
    ],
    [
      "a step after the db-assets stage's scan",
      dbScan(`RUN ${APP_DB_SCAN_STEP} && cp -r packages/testing /out/db-assets/\n`),
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
      dbScan(`RUN ${APP_DB_SCAN_STEP} || true\n`),
      new RegExp(
        `^${APP_DOCKERFILE}: \`node .*\` holds \`\\|\`, which the test does not read as a word$`,
      ),
    ],
    [
      "the db-assets stage's scan run with a mount over the copy",
      dbScan(
        `RUN --mount=type=bind,from=deps,source=/src/packages/db,target=/out/db-assets ${APP_DB_SCAN_STEP}\n`,
      ),
      new RegExp(`^${stage} has a RUN on line \\d+ that is not a plain shell command$`),
    ],
    [
      "the db-assets stage's scan in exec form",
      dbScan(`RUN ["node", "${SCAN_SCRIPT}", "${DB_ASSETS_SCAN}", "/out/db-assets"]\n`),
      new RegExp(`^${stage} has a RUN on line \\d+ that is not a plain shell command$`),
    ],
    [
      "a RUN before the db-assets stage's scan that copies the harness into the copy",
      dbStage(
        `${APP_DB_PRODUCE}RUN cp -r packages/testing/src /out/db-assets/harness\n${APP_DB_SCAN}`,
      ),
      exactly,
    ],
    [
      "a step before the scan, in the scan's RUN, that copies the harness into the copy",
      dbStage(
        `${APP_DB_PRODUCE}RUN cp -r packages/testing/src /out/db-assets/harness && ${APP_DB_SCAN_STEP}\n`,
      ),
      exactly,
    ],
    [
      "a test-target build copied into the copy before the db-assets stage's scan",
      dbStage(
        `${APP_DB_PRODUCE}RUN FIN_BUILD_TARGET=test pnpm --filter @fin/api run build:server && cp -r apps/api/dist/server /out/db-assets/server\n${APP_DB_SCAN}`,
      ),
      exactly,
    ],
    [
      "a migration planted in the copy before the staging command",
      dbStage(
        `RUN mkdir -p /out/db-assets/packages/zz/migrations\n${APP_DB_PRODUCE}${APP_DB_SCAN}`,
      ),
      exactly,
    ],
    [
      "the staging command replaced by a copy of the repository",
      dbStage(`RUN mkdir -p /out && cp -r /src /out/db-assets\n${APP_DB_SCAN}`),
      exactly,
    ],
    ["the staging command left out", dbStage(APP_DB_SCAN), exactly],
    [
      "the staging command into another directory",
      dbStage(`RUN ${DB_STAGE_COMMAND}/harness\n${APP_DB_SCAN}`),
      exactly,
    ],
    [
      "the staging command with a flag added",
      dbStage(
        `RUN ${DB_STAGE_COMMAND.replace("node ", "node --import=/src/skip.mjs ")}\n${APP_DB_SCAN}`,
      ),
      exactly,
    ],
    [
      "the scan emptied before it runs",
      dbStage(`${APP_DB_PRODUCE}RUN cp /dev/null ${SCAN_SCRIPT}\n${APP_DB_SCAN}`),
      exactly,
    ],
    [
      "the scan run from another directory after a cd",
      dbStage(
        `${APP_DB_PRODUCE}RUN mkdir -p /tmp/x/ops/docker && cp /dev/null /tmp/x/${SCAN_SCRIPT} && cd /tmp/x && ${APP_DB_SCAN_STEP}\n`,
      ),
      exactly,
    ],
    [
      "a WORKDIR of the db-assets stage's own before its scan",
      dbStage(`${APP_DB_PRODUCE}WORKDIR /tmp/x\n${APP_DB_SCAN}`),
      own("WORKDIR"),
    ],
    [
      "an ENV of the db-assets stage's own before its scan",
      dbStage(`${APP_DB_PRODUCE}ENV NODE_OPTIONS=--import=/src/skip.mjs\n${APP_DB_SCAN}`),
      own("ENV"),
    ],
    [
      "an ARG of the db-assets stage's own, read at its default, in its scan's directory",
      dbStage(
        `ARG APP=../../out/db-assets\n${APP_DB_PRODUCE}RUN node ${SCAN_SCRIPT} ${DB_ASSETS_SCAN} "/src/apps/\${APP}"\n`,
      ),
      own("ARG"),
    ],
    [
      "a SHELL of the db-assets stage's own",
      dbStage(`SHELL ["/bin/sh", "-c"]\n${APP_DB_PRODUCE}${APP_DB_SCAN}`),
      own("SHELL"),
    ],
    [
      "the db-assets stage built on another stage than the bundle's build stage",
      (files) =>
        replace(
          files,
          APP_DOCKERFILE,
          "FROM deps AS db-assets\n",
          "FROM deps AS planted\nRUN mkdir -p packages/zz/migrations\nFROM planted AS db-assets\n",
        ),
      `${stage} is built on planted, not on deps, the stage the bundle's build stage build-release is built on`,
    ],
    [
      "the db-assets stage run in another directory than the bundle's build stage",
      (files) =>
        replace(
          files,
          APP_DOCKERFILE,
          "FROM deps AS build-release\nARG APP\n",
          "FROM deps AS build-release\nARG APP\nWORKDIR /\n",
        ),
      `${api}: ${which} runs in /src, not in /, where the bundle's build stage build-release runs pnpm`,
    ],
    [
      "the listed copy once the allowlist names it for another Dockerfile",
      firstCopy((copy) => {
        copy.dockerfile = CONNECTOR_DOCKERFILE;
      }),
      twice,
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
      `${ALLOWLIST_FILE}: copy 1 holds destination, dockerfile, produces, source, stage, not exactly dockerfile, stage, source, destination, produces, reason`,
    ],
    [
      "an allowlisted copy without the command that makes it",
      firstCopy((copy) => {
        delete copy.produces;
      }),
      `${ALLOWLIST_FILE}: copy 1 holds destination, dockerfile, reason, source, stage, not exactly dockerfile, stage, source, destination, produces, reason`,
    ],
    [
      "an allowlisted copy without its Dockerfile",
      firstCopy((copy) => {
        delete copy.dockerfile;
      }),
      `${ALLOWLIST_FILE}: copy 1 holds destination, produces, reason, source, stage, not exactly dockerfile, stage, source, destination, produces, reason`,
    ],
    [
      "an allowlisted copy made by two commands",
      firstCopy((copy) => {
        copy.produces = `${DB_STAGE_COMMAND} && cp -r packages/testing/src /out/db-assets/`;
      }),
      `${ALLOWLIST_FILE}: copy 1's produces, ${JSON.stringify(`${DB_STAGE_COMMAND} && cp -r packages/testing/src /out/db-assets/`)}, is not one command of plain words`,
    ],
    [
      "an allowlisted copy made by a command that expands a variable",
      firstCopy((copy) => {
        copy.produces = "node packages/db/src/assets-cli.ts stage $OUT";
      }),
      `${ALLOWLIST_FILE}: copy 1's produces, "node packages/db/src/assets-cli.ts stage $OUT", is not one command of plain words`,
    ],
    [
      "an allowlisted copy made by a command that is an assignment first",
      firstCopy((copy) => {
        copy.produces = `NODE_OPTIONS=--import=/src/skip.mjs ${DB_STAGE_COMMAND}`;
      }),
      `${ALLOWLIST_FILE}: copy 1's produces, ${JSON.stringify(`NODE_OPTIONS=--import=/src/skip.mjs ${DB_STAGE_COMMAND}`)}, is not one command of plain words`,
    ],
    [
      "an allowlisted copy of a Dockerfile outside ops/docker",
      firstCopy((copy) => {
        copy.dockerfile = "Dockerfile";
      }),
      `${ALLOWLIST_FILE}: copy 1's dockerfile, "Dockerfile", is not a Dockerfile of ops/docker`,
    ],
    [
      "an allowlisted copy of a Dockerfile in a directory under ops/docker",
      firstCopy((copy) => {
        copy.dockerfile = "ops/docker/sub/app.Dockerfile";
      }),
      `${ALLOWLIST_FILE}: copy 1's dockerfile, "ops/docker/sub/app.Dockerfile", is not a Dockerfile of ops/docker`,
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

  // The steward's ruling of 22 Nov on the db-assets copy: each of the attacker's variants fails, by
  // the reader (the Dockerfile planted and read), by the scan of the stage's output (what the stage
  // would leave, made in a temporary directory and scanned in the database files' mode as the stage
  // runs it), or by both, as each test's title says. A scan cannot see that it was emptied,
  // replaced, run elsewhere or run with another environment, so those variants are the reader's
  // alone; so is a file planted in deps in a folder assets.ts reads, with none of the harness's
  // markers, which the scan would pass as a migration. The scan's side of each variant holds even
  // when the staging command itself is changed, which no Dockerfile shows: two variants are the
  // scan's alone.
  describe("each variant of the steward's ruling", () => {
    const INSTALL = "RUN pnpm install --offline --frozen-lockfile\n";
    /** app.Dockerfile with `line` planted in deps, after its last instruction. */
    const inDeps = (line: string) => (files: Map<string, string>) =>
      replace(files, APP_DOCKERFILE, INSTALL, `${INSTALL}${line}\n`);
    const base = (keyword: string) =>
      new RegExp(
        `^${literal(APP_DOCKERFILE)}: its base stage deps has ${keyword} on line \\d+, after the pinned base's last instruction$`,
      );
    /** What the allowlisted command stages, in a new directory: the database's files. */
    const staged = (): string => {
      const out = join(temporary(), "db-assets");
      const run = spawnSync(
        process.execPath,
        [join(REPOSITORY, "packages/db/src/assets-cli.ts"), "stage", out],
        { cwd: REPOSITORY, encoding: "utf8", env: { PATH: dirname(process.execPath) } },
      );
      if (run.status !== 0) throw new Error(`the staging command failed: ${run.stderr}`);
      return out;
    };
    /** `out` with each of `files` (a path in it to its text) written in it. */
    const plus = (out: string, files: Readonly<Record<string, string>>): string => {
      writeFiles(out, new Map(Object.entries(files)));
      return out;
    };
    /** `out` with the repository's files `paths` (files or directories) copied to `to` in it. */
    const copied = (out: string, paths: Readonly<Record<string, string>>): string => {
      for (const [path, to] of Object.entries(paths)) {
        cpSync(join(REPOSITORY, path), join(out, to), { recursive: true });
      }
      return out;
    };
    const none = "which is none of the database's files (.sql and .json files only)";
    const outside =
      "a file outside the database's folders (packages/<package>/bootstrap, migrations or grants, and packages/db/roles/grants)";
    const harness =
      "a path of the test harness (packages/testing), which only the test target may hold";
    const ENTRYPOINT = 'ENTRYPOINT ["/nodejs/bin/node", "/app/db-assets/server/main.js"]\n';
    const TEST_BUNDLE = "// ../../packages/testing/src/totp.ts\nexport const totp = 1;\n";

    interface Reader {
      change: (files: Map<string, string>) => void;
      refusal: string | RegExp;
      label?: string;
    }
    interface Scan {
      output: () => string;
      file: string;
      what: string;
    }
    const variant = (name: string, reader: Reader | undefined, scan: Scan | undefined) => ({
      title: `${name}: refused by ${
        reader !== undefined && scan !== undefined
          ? "the reader and the scan"
          : reader !== undefined
            ? "the reader"
            : "the scan"
      }`,
      reader,
      scan,
    });

    it.each([
      variant(
        "(1) the harness's sources copied into the copy between the stage's RUNs",
        {
          change: dbStage(
            `${APP_DB_PRODUCE}RUN cp -r packages/testing/src /out/db-assets/harness\n${APP_DB_SCAN}`,
          ),
          refusal: exactly,
        },
        {
          output: () => copied(staged(), { "packages/testing/src": "harness" }),
          file: "harness/totp.ts",
          what: `a .ts file, ${none}`,
        },
      ),
      variant(
        "(2) a test-target bundle copied into the copy, with an ENTRYPOINT that starts it",
        {
          change: (files) => {
            dbStage(
              `${APP_DB_PRODUCE}RUN FIN_BUILD_TARGET=test pnpm --filter @fin/api run build:server && cp -r apps/api/dist/server /out/db-assets/server\n${APP_DB_SCAN}`,
            )(files);
            releaseCopy(`${APP_DB_COPY}${ENTRYPOINT}`)(files);
          },
          refusal: exactly,
        },
        {
          output: () =>
            plus(staged(), { "server/main.js": TEST_BUNDLE, "server/main.js.map": "{}" }),
          file: "server/main.js",
          what: `a .js file, ${none}`,
        },
      ),
      variant(
        "(2) that ENTRYPOINT alone",
        {
          change: releaseCopy(`${APP_DB_COPY}${ENTRYPOINT}`),
          refusal: new RegExp(`^${literal(api)}: its release stage has ENTRYPOINT on line \\d+$`),
        },
        undefined,
      ),
      variant(
        "(3) the staging command replaced by a copy of the repository",
        {
          change: dbStage(`RUN mkdir -p /out && cp -r /src /out/db-assets\n${APP_DB_SCAN}`),
          refusal: exactly,
        },
        {
          output: () =>
            copied(staged(), {
              "package.json": "package.json",
              "packages/db/src/assets.ts": "packages/db/src/assets.ts",
              "packages/testing/src/totp.ts": "packages/testing/src/totp.ts",
            }),
          file: "packages/testing/src/totp.ts",
          what: harness,
        },
      ),
      variant(
        "(4) the scan emptied before it runs, in the stage",
        {
          change: dbStage(`${APP_DB_PRODUCE}RUN cp /dev/null ${SCAN_SCRIPT}\n${APP_DB_SCAN}`),
          refusal: exactly,
        },
        undefined,
      ),
      variant(
        "(4) the scan emptied before it runs, in deps",
        { change: inDeps(`RUN cp /dev/null ${SCAN_SCRIPT}`), refusal: base("RUN") },
        undefined,
      ),
      variant(
        "(5) the scan run from another WORKDIR",
        {
          change: dbStage(`${APP_DB_PRODUCE}WORKDIR /tmp/x\n${APP_DB_SCAN}`),
          refusal: own("WORKDIR"),
        },
        undefined,
      ),
      variant(
        "(5) the scan run after a cd to a copied scanner",
        {
          change: dbStage(
            `${APP_DB_PRODUCE}RUN mkdir -p /tmp/x/ops/docker && cp /dev/null /tmp/x/${SCAN_SCRIPT} && cd /tmp/x && ${APP_DB_SCAN_STEP}\n`,
          ),
          refusal: exactly,
        },
        undefined,
      ),
      variant(
        "(6) NODE_OPTIONS set by an ENV of the stage before the scan",
        {
          change: dbStage(
            `${APP_DB_PRODUCE}ENV NODE_OPTIONS=--import=/src/skip.mjs\n${APP_DB_SCAN}`,
          ),
          refusal: own("ENV"),
        },
        undefined,
      ),
      variant(
        "(6) NODE_OPTIONS set on the scan's step",
        {
          change: dbScan(`RUN NODE_OPTIONS=--import=/src/skip.mjs ${APP_DB_SCAN_STEP}\n`),
          refusal: unscanned,
        },
        undefined,
      ),
      variant(
        "(6) NODE_OPTIONS exported by a step before the scan",
        {
          change: dbScan(`RUN export NODE_OPTIONS=--import=/src/skip.mjs && ${APP_DB_SCAN_STEP}\n`),
          refusal: exactly,
        },
        undefined,
      ),
      variant(
        "(6) NODE_OPTIONS set by an ENV in deps",
        { change: inDeps("ENV NODE_OPTIONS=--import=/src/skip.mjs"), refusal: base("ENV") },
        undefined,
      ),
      variant(
        "(6) NODE_OPTIONS set by an ARG in deps, which Docker passes on",
        {
          change: inDeps("ARG NODE_OPTIONS=--import=/src/ops/docker/skip.mjs"),
          refusal: new RegExp(
            `^${literal(APP_DOCKERFILE)}: ARG on line \\d+ is in deps, which db-assets is built on: Docker passes it on to the stages built on deps, which the test does not read$`,
          ),
        },
        undefined,
      ),
      variant(
        "(7) an ARG's default in the scan's directory, which the build's APP replaces",
        {
          change: dbStage(
            `ARG APP=../../out/db-assets\n${APP_DB_PRODUCE}RUN node ${SCAN_SCRIPT} ${DB_ASSETS_SCAN} "/src/apps/\${APP}"\n`,
          ),
          refusal: own("ARG"),
        },
        undefined,
      ),
      variant(
        "(8) a stage named db-assets in connector.Dockerfile that never runs assets-cli",
        {
          change: (files) => {
            replace(
              files,
              CONNECTOR_DOCKERFILE,
              "FROM deps AS build\n",
              `FROM deps AS db-assets\nRUN mkdir -p /out/db-assets && cp -r packages/testing/src /out/db-assets/harness\n${APP_DB_SCAN}\nFROM deps AS build\n`,
            );
            replace(files, CONNECTOR_DOCKERFILE, CONNECTOR_COPY, `${CONNECTOR_COPY}${APP_DB_COPY}`);
          },
          refusal: `${CONNECTOR_DOCKERFILE}: its ${RELEASE_STAGE} stage copies 2 times from stages that hold the repository, not once`,
          label: CONNECTOR_DOCKERFILE,
        },
        {
          output: () => {
            const out = join(temporary(), "db-assets");
            mkdirSync(out);
            return copied(out, { "packages/testing/src": "harness" });
          },
          file: "harness/totp.ts",
          what: `a .ts file, ${none}`,
        },
      ),
      variant(
        "a migration planted in the copy under a folder assets.ts does not know",
        {
          change: dbStage(
            `${APP_DB_PRODUCE}RUN mkdir -p /out/db-assets/packages/db/seeds && cp packages/db/migrations/20261121101000_audit_core.sql /out/db-assets/packages/db/seeds/20990101000000_seed.sql\n${APP_DB_SCAN}`,
          ),
          refusal: exactly,
        },
        {
          output: () =>
            plus(staged(), {
              "packages/db/seeds/20990101000000_seed.sql":
                "grant all on all tables in schema public to public;\n",
            }),
          file: "packages/db/seeds/20990101000000_seed.sql",
          what: outside,
        },
      ),
      variant(
        "the harness planted in deps as a migration in a folder assets.ts reads",
        {
          change: inDeps(
            "RUN mkdir -p packages/zz/migrations && cp packages/testing/src/totp.ts packages/zz/migrations/20990101000000_zz_totp.sql",
          ),
          refusal: base("RUN"),
        },
        undefined,
      ),
      variant(
        "a migration of packages/testing in the repository, which assets.ts's rule would stage",
        undefined,
        {
          output: () =>
            plus(staged(), {
              "packages/testing/migrations/20990101000000_testing_seed.sql":
                "insert into staff (email) values ('planted@example.org');\n",
            }),
          file: "packages/testing/migrations/20990101000000_testing_seed.sql",
          what: harness,
        },
      ),
      variant("the staging command changed to stage the harness's sources too", undefined, {
        output: () => copied(staged(), { "packages/testing/src": "packages/testing/src" }),
        file: "packages/testing/src/totp.ts",
        what: harness,
      }),
    ])(
      "$title",
      ({ reader, scan }) => {
        if (reader !== undefined) {
          const images = imageBuilds(plantRepository(reader.change));
          expect(images.refusals).toContainEqual(
            typeof reader.refusal === "string"
              ? reader.refusal
              : expect.stringMatching(reader.refusal),
          );
          expect(images.builds.map((build) => build.label)).not.toContain(reader.label ?? api);
        }
        if (scan !== undefined) {
          const out = scan.output();
          const result = runHarnessScan(REPOSITORY, out, [DB_ASSETS_SCAN]);
          expect(result.status).toBe(1);
          expect(result.stderr.split("\n")).toContain(
            `harness-scan: ${out}/${scan.file}: ${scan.what}`,
          );
        }
      },
      30_000,
    );
  });
});

// The stages under each Dockerfile's bundle build stage (deps), and so under app.Dockerfile's
// db-assets stage, are the pinned base, word for word: a RUN, a step, an ENV (NODE_OPTIONS, PATH,
// BASH_ENV, ENV or a name added to the base's), an ARG, an ADD, a COPY or any other instruction
// planted there is refused, and so are a base image that is not Node's by digest, pnpm from
// anywhere but its release asset, and a script of the workspace's manifests that the base's pnpm
// install runs. Each would run before the database files' scan and the bundle's, so it could empty
// or replace a scan or the staging command, set what Node or the shell reads, or plant a file in a
// folder assets.ts stages (which the database files' scan, reading folders and extensions, would
// pass: only the reader refuses that one).
describe.each([
  { dockerfile: APP_DOCKERFILE, label: `${APP_DOCKERFILE}, APP=api` },
  { dockerfile: CONNECTOR_DOCKERFILE, label: CONNECTOR_DOCKERFILE },
])("$dockerfile: the stages the bundle's build stage is built on", ({ dockerfile, label }) => {
  const INSTALL = "RUN pnpm install --offline --frozen-lockfile\n";
  const PNPM_ASSET =
    "https://github.com/pnpm/pnpm/releases/download/v12.21.0/pnpm-linux-x64.tar.gz";
  /** The Dockerfile with `line` after the base's last instruction. */
  const after = (line: string) => (files: Map<string, string>) =>
    replace(files, dockerfile, INSTALL, `${INSTALL}${line}\n`);
  /** The Dockerfile with its deps stage's FROM line replaced by `to`. */
  const from = (to: string) => (files: Map<string, string>) => {
    const text = files.get(dockerfile) ?? "";
    const line = /^FROM (\S+) AS deps$/m.exec(text);
    if (line === null) throw new Error(`${dockerfile} has no deps stage`);
    files.set(
      dockerfile,
      text.replace(line[0], () => to.replace("<image>", line[1] ?? "")),
    );
  };
  /** The refusal of an instruction `keyword` after the pinned base's last. */
  const appended = (keyword: string) =>
    new RegExp(
      `^its base stage deps has ${keyword} on line \\d+, after the pinned base's last instruction$`,
    );
  /** The refusal of an instruction where the pinned base has one that begins with `expected`. */
  const differs = (stage: string, expected: string) =>
    new RegExp(
      `^its base stage ${stage} has \`.*\` on line \\d+, where the pinned base has \`${literal(expected)}.*\`$`,
    );

  it.each<[string, (files: Map<string, string>) => void, RegExp]>([
    ["a RUN that empties the scan", after(`RUN cp /dev/null ${SCAN_SCRIPT}`), appended("RUN")],
    [
      "a RUN that replaces the database files' staging command",
      after("RUN cp ops/docker/evil.ts packages/db/src/assets-cli.ts"),
      appended("RUN"),
    ],
    [
      "a RUN that plants the harness as a migration in a folder assets.ts reads",
      after(
        "RUN mkdir -p packages/zz/migrations && cp packages/testing/src/totp.ts packages/zz/migrations/20990101000000_zz_totp.sql",
      ),
      appended("RUN"),
    ],
    [
      "a RUN that plants a migration in a folder assets.ts does not read",
      after(
        "RUN mkdir -p packages/db/seeds && cp packages/db/migrations/20261121101000_audit_core.sql packages/db/seeds/20990101000000_seed.sql",
      ),
      appended("RUN"),
    ],
    ["an ENV of NODE_OPTIONS", after("ENV NODE_OPTIONS=--import=/src/skip.mjs"), appended("ENV")],
    [
      "an ENV of PATH",
      after("ENV PATH=/src/fakebin:/usr/local/bin:/usr/bin:/bin"),
      appended("ENV"),
    ],
    ["an ENV of BASH_ENV", after("ENV BASH_ENV=/src/evil.sh"), appended("ENV")],
    ["an ENV of ENV", after("ENV ENV=/src/evil.sh"), appended("ENV")],
    [
      "a name added to the base's ENV",
      (files) =>
        replace(
          files,
          dockerfile,
          "    CI=1\n",
          "    CI=1 \\\n    NODE_OPTIONS=--import=/src/skip.mjs\n",
        ),
      differs("deps", "ENV TURBO_TELEMETRY_DISABLED=1 CI=1"),
    ],
    [
      "an ARG of NODE_OPTIONS, which Docker passes on to the stages built on deps",
      after("ARG NODE_OPTIONS=--import=/src/ops/docker/skip.mjs"),
      /^(?:its base stage deps has ARG on line \d+, after the pinned base's last instruction|ARG on line \d+ is in deps, which db-assets is built on: Docker passes it on to the stages built on deps, which the test does not read)$/,
    ],
    [
      "a COPY from the build context",
      after("COPY packages/testing/src/totp.ts packages/zz/migrations/20990101000000_zz_totp.sql"),
      appended("COPY"),
    ],
    [
      "an ADD over the scan",
      after(
        `ADD --checksum=sha256:${"0".repeat(64)} https://example.org/x.mjs /src/${SCAN_SCRIPT}`,
      ),
      appended("ADD"),
    ],
    ["another instruction", after("USER nobody"), appended("USER")],
    [
      "a step added to the install's RUN",
      (files) =>
        replace(
          files,
          dockerfile,
          INSTALL,
          `${INSTALL.trimEnd()} && cp /dev/null ${SCAN_SCRIPT}\n`,
        ),
      differs("deps", "RUN pnpm install --offline --frozen-lockfile"),
    ],
    [
      "pnpm from another URL",
      (files) =>
        replace(files, dockerfile, PNPM_ASSET, "https://example.org/pnpm-linux-x64.tar.gz"),
      differs("deps", "ADD --checksum=sha256:<hash> https://github.com/pnpm/pnpm/"),
    ],
    [
      "pnpm's asset added over the scan",
      (files) =>
        replace(
          files,
          dockerfile,
          `${PNPM_ASSET} /tmp/pnpm.tar.gz`,
          `${PNPM_ASSET} /src/${SCAN_SCRIPT}`,
        ),
      differs("deps", "ADD --checksum=sha256:<hash> https://github.com/pnpm/pnpm/"),
    ],
    [
      "a base image not pinned by digest",
      from("FROM node:26 AS deps"),
      /^its base stage deps is built on node:26, not on Node's image pinned by digest$/,
    ],
    [
      "another image pinned by digest",
      from(`FROM example.org/node@sha256:${"a".repeat(64)} AS deps`),
      /^its base stage deps is built on example\.org\/node@sha256:a{64}, not on Node's image pinned by digest$/,
    ],
    [
      "a stage under deps that runs a command first",
      from(`FROM <image> AS base\nRUN cp /dev/null ${SCAN_SCRIPT}\nFROM base AS deps`),
      differs("base", 'SHELL ["/bin/bash"'),
    ],
    [
      "a script of the root's manifest that pnpm's install runs",
      (files) =>
        files.set(
          "package.json",
          JSON.stringify({
            name: "fin-next",
            scripts: { postinstall: `cp /dev/null ${SCAN_SCRIPT}` },
          }),
        ),
      /^package\.json has a postinstall script, which the base's pnpm install runs$/,
    ],
    [
      "a script of an app's manifest that pnpm's install runs",
      (files) => setScripts(files, "api", { prepare: `cp /dev/null ${SCAN_SCRIPT}` }),
      /^apps\/api\/package\.json has a prepare script, which the base's pnpm install runs$/,
    ],
  ])("refuses %s", (_name, change, refusal) => {
    const images = imageBuilds(plantRepository(change));
    const prefix = `${dockerfile}: `;
    const refusals = images.refusals
      .filter((each) => each.startsWith(prefix))
      .map((each) => each.slice(prefix.length));
    expect(refusals).toContainEqual(expect.stringMatching(refusal));
    expect(images.builds.map((build) => build.label)).not.toContain(label);
  });
});

// How each Dockerfile's release stage starts its image: the run image's entrypoint, node, runs the
// stage's one CMD, which is Node flags the reader knows and then the bundle's main.js. An
// ENTRYPOINT or a HEALTHCHECK (either could start something else, such as a bundle planted beside
// the database's files), an ENV that sets a NODE_* variable, a CMD that starts another file, gives
// another flag or is not in exec form, no CMD or two, and a parent stage's ENTRYPOINT, CMD or ARG
// are refused.
describe.each([
  { dockerfile: APP_DOCKERFILE, label: `${APP_DOCKERFILE}, APP=api`, copy: APP_COPY },
  { dockerfile: CONNECTOR_DOCKERFILE, label: CONNECTOR_DOCKERFILE, copy: CONNECTOR_COPY },
])("$dockerfile's release stage starts its bundle alone", ({ dockerfile, label, copy }) => {
  const CMD =
    'CMD ["--max-old-space-size-percentage=70", "--disable-proto=throw", "--enable-source-maps", "dist/main.js"]\n';
  /** `text` with `from`, which it must hold once, replaced by `to`. */
  const swap = (text: string, from: string, to: string): string => {
    if (text.split(from).length !== 2) throw new Error(`${dockerfile} does not hold ${from} once`);
    return text.replace(from, () => to);
  };
  /** The release stage's CMD (the file's last) replaced by `to`. */
  const cmd = (to: string) => (text: string) => {
    const at = text.lastIndexOf(CMD);
    if (at === -1 || !text.endsWith(CMD)) throw new Error(`${dockerfile} does not end in ${CMD}`);
    return `${text.slice(0, at)}${to}`;
  };
  /** `lines` after the release stage's copy of the bundle. */
  const second = (lines: string) => (text: string) => swap(text, copy, `${copy}${lines}`);
  /** The release stage built on `runtime`, a stage of `lines` on the release stage's own image. */
  const parent = (lines: string) => (text: string) =>
    swap(text, " AS release\n", ` AS runtime\n${lines}FROM runtime AS release\n`);
  const PLANTED = '["/nodejs/bin/node", "/app/db-assets/server/main.js"]';

  it.each<[string, (text: string) => string, RegExp]>([
    [
      "an ENTRYPOINT that starts a bundle planted beside the database's files",
      second(`ENTRYPOINT ${PLANTED}\n`),
      /^its release stage has ENTRYPOINT on line \d+$/,
    ],
    [
      "a HEALTHCHECK that runs a planted file",
      second(`HEALTHCHECK CMD ${PLANTED}\n`),
      /^its release stage has HEALTHCHECK on line \d+$/,
    ],
    [
      "an ENV of NODE_OPTIONS",
      second("ENV NODE_OPTIONS=--import=/app/db-assets/server/main.js\n"),
      /^its release stage sets NODE_OPTIONS on line \d+, which Node reads$/,
    ],
    [
      "an ENV of NODE_OPTIONS in the older form",
      second("ENV NODE_OPTIONS --import=/app/db-assets/server/main.js\n"),
      /^its release stage sets NODE_OPTIONS on line \d+, which Node reads$/,
    ],
    [
      "a CMD that starts another file",
      cmd('CMD ["--enable-source-maps", "db-assets/server/main.js"]\n'),
      /^its release stage's CMD on line \d+ starts "db-assets\/server\/main\.js", not \/app\/dist\/main\.js, the bundle's main\.js$/,
    ],
    [
      "a CMD with a flag that loads a module",
      cmd('CMD ["--import=/app/db-assets/x.mjs", "dist/main.js"]\n'),
      /^its release stage's CMD on line \d+ gives Node "--import=\/app\/db-assets\/x\.mjs", which the test does not read$/,
    ],
    [
      "a CMD of a flag alone",
      cmd('CMD ["--enable-source-maps"]\n'),
      /^its release stage's CMD on line \d+ starts "--enable-source-maps", not \/app\/dist\/main\.js, the bundle's main\.js$/,
    ],
    [
      "a CMD in shell form",
      cmd("CMD node dist/main.js\n"),
      /^its release stage's CMD on line \d+ is not in exec form$/,
    ],
    ["no CMD", cmd(""), /^its release stage has 0 CMD instructions, not one$/],
    [
      "a second CMD",
      cmd(`${CMD}CMD ["dist/main.js"]\n`),
      /^its release stage has 2 CMD instructions, not one$/,
    ],
    [
      "a parent stage's ENTRYPOINT",
      parent(`ENTRYPOINT ${PLANTED}\n`),
      /^runtime, which its release stage is built on, has ENTRYPOINT on line \d+$/,
    ],
    [
      "a parent stage's CMD",
      parent('CMD ["db-assets/server/main.js"]\n'),
      /^runtime, which its release stage is built on, has CMD on line \d+$/,
    ],
    [
      "a parent stage's ARG, which Docker passes on to the release stage",
      parent("ARG APP=../../../src/packages/testing\n"),
      /^ARG on line \d+ is in runtime, which release is built on: Docker passes it on to the stages built on runtime, which the test does not read$/,
    ],
  ])("refuses %s", (_name, change, refusal) => {
    const images = imageBuilds(
      plantRepository((files) => files.set(dockerfile, change(files.get(dockerfile) ?? ""))),
    );
    const prefix = `${label}: `;
    const refusals = images.refusals
      .filter((each) => each.startsWith(prefix))
      .map((each) => each.slice(prefix.length));
    expect(refusals).toContainEqual(expect.stringMatching(refusal));
    expect(images.builds.map((build) => build.label)).not.toContain(label);
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
  // code), with a `//#region` as CI's bundle check (back with the tokenizer PR) reads one, a
  // comment that names the harness's directory in a sentence, and a string that names another
  // package's testing subpath.
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
      "a region of packages/testing, as CI's bundle check reads one",
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

  // The database files' mode, in which app.Dockerfile's db-assets stage runs the scan: beside the
  // markers, every file must be one of the database's files as packages/db/src/assets.ts finds them
  // (a .sql file in packages/<package>/bootstrap or migrations, a .json file in
  // packages/<package>/grants or packages/db/roles/grants), no path may contain packages/testing,
  // and every directory must be one those files lie in or under. packages/db's assets.test.ts holds
  // this rule equal to assets.ts's over a planted tree.
  describe("in its database files' mode", () => {
    const DB = {
      "packages/db/bootstrap/010_roles.sql": "select 1;\n",
      "packages/db/migrations/20261121101000_audit_core.sql": "select 1;\n",
      "packages/db/roles/grants/ops.json": '{"area":"ops","grants":[]}\n',
    };
    const scanDb = (dir: string) => runHarnessScan(REPOSITORY, dir, [DB_ASSETS_SCAN]);
    const NONE = "which is none of the database's files (.sql and .json files only)";
    const OUTSIDE =
      "a file outside the database's folders (packages/<package>/bootstrap, migrations or grants, and packages/db/roles/grants)";
    const HARNESS =
      "a path of the test harness (packages/testing), which only the test target may hold";

    it("passes the database's files, in each of their folders and extensions", () => {
      const dir = output({
        ...DB,
        "packages/zz/bootstrap/015_zz.sql": "select 1;\n",
        "packages/zz/migrations/20990101000000_zz_x.SQL": "select 1;\n",
        "packages/a-b2/migrations/20990101000100_ab_x.sql": "select 1;\n",
        "packages/zz/grants/zz.json": "{}\n",
        "packages/db/grants/db.json": "{}\n",
      });
      const scan = scanDb(dir);
      expect([scan.status, scan.stderr]).toEqual([0, ""]);
      expect(scan.stdout).toContain("8 file(s), the database's files only, no harness marker");
    }, 30_000);

    it.each<[string, string, string, string?]>([
      ["a .ts file", "packages/db/migrations/20990101000000_x.ts", `a .ts file, ${NONE}`],
      ["a .js file", "packages/db/migrations/run.js", `a .js file, ${NONE}`],
      ["a .mjs file", "packages/db/grants/x.mjs", `a .mjs file, ${NONE}`],
      ["a map", "packages/db/migrations/x.sql.map", `a .map file, ${NONE}`],
      [
        "a file with no extension",
        "packages/db/migrations/README",
        `a file with no extension, ${NONE}`,
      ],
      [
        "a .sql file in a folder assets.ts does not read",
        "packages/db/seeds/20990101000000_seed.sql",
        OUTSIDE,
      ],
      ["a .sql file outside packages", "zz/unknown/20990101000000_x.sql", OUTSIDE],
      ["a .json file at the root", "grants.json", OUTSIDE],
      ["a .sql file in a package's own directory", "packages/db/x.sql", OUTSIDE],
      [
        "a .sql file in a folder under migrations",
        "packages/db/migrations/old/20990101000000_x.sql",
        OUTSIDE,
      ],
      [
        "a package's roles/grants, which only packages/db has",
        "packages/zz/roles/grants/zz.json",
        OUTSIDE,
      ],
      [
        "a package whose name assets.ts does not read",
        "packages/Zz9/migrations/20990101000000_x.sql",
        OUTSIDE,
      ],
      [
        "a package whose name begins with a digit",
        "packages/9zz/migrations/20990101000000_x.sql",
        OUTSIDE,
      ],
      [
        "a .json file among the migrations",
        "packages/db/migrations/x.json",
        "a .json file in packages/db/migrations, which holds .sql files only",
      ],
      [
        "a .sql file among the grants",
        "packages/db/roles/grants/x.sql",
        "a .sql file in packages/db/roles/grants, which holds .json files only",
      ],
      [
        "a migration of packages/testing",
        "packages/testing/migrations/20990101000000_testing_seed.sql",
        HARNESS,
      ],
      ["a grant of packages/testing", "packages/testing/grants/testing.json", HARNESS],
      [
        "a package whose name begins with testing",
        "packages/testing-kit/migrations/20990101000000_x.sql",
        HARNESS,
      ],
      ["a path through the harness's package link", "node_modules/@fin/testing/x.sql", HARNESS],
      [
        "a database file that carries a seam's marker",
        "packages/db/migrations/20990101000000_x.sql",
        "a test seam's marker (fin:test-seam)",
        "-- fin:test-seam\nselect 1;\n",
      ],
    ])(
      "refuses %s",
      (_name, file, what, text = "select 1;\n") => {
        const dir = output({ ...DB, [file]: text });
        const scan = scanDb(dir);
        expect(scan.status).toBe(1);
        expect(scan.stderr.split("\n")).toContain(`harness-scan: ${dir}/${file}: ${what}`);
        expect(scan.stderr).toContain(
          "what the image copies as the database's files holds more than them, or the test harness",
        );
      },
      30_000,
    );

    it("refuses a directory outside the database's folders, empty or not", () => {
      const dir = output(DB);
      mkdirSync(join(dir, "harness"));
      mkdirSync(join(dir, "packages/testing"));
      const scan = scanDb(dir);
      expect(scan.status).toBe(1);
      const lines = scan.stderr.split("\n");
      expect(lines).toContain(
        `harness-scan: ${dir}/harness: a directory outside the database's folders`,
      );
      expect(lines).toContain(`harness-scan: ${dir}/packages/testing: ${HARNESS}`);
    }, 30_000);

    it("refuses the harness's raw sources, which the bundle's mode passes", () => {
      const dir = output(DB);
      cpSync(join(REPOSITORY, "packages/testing/src"), join(dir, "packages/testing/src"), {
        recursive: true,
      });
      expect(runHarnessScan(REPOSITORY, dir).status).toBe(0);
      const scan = scanDb(dir);
      expect(scan.status).toBe(1);
      expect(scan.stderr.split("\n")).toContain(
        `harness-scan: ${dir}/packages/testing/src/totp.ts: ${HARNESS}`,
      );
    }, 30_000);

    it("refuses a link, an empty output and a usage it does not read", () => {
      const dir = output(DB);
      symlinkSync(
        join(REPOSITORY, "packages/db/migrations/20261121101000_audit_core.sql"),
        join(dir, "packages/db/migrations/20990101000000_link.sql"),
      );
      const linked = scanDb(dir);
      expect(linked.status).toBe(1);
      expect(linked.stderr).toContain(
        `harness-scan: ${dir}/packages/db/migrations/20990101000000_link.sql: a link, which the image would copy as a link`,
      );
      const empty = join(temporary(), "empty");
      mkdirSync(empty);
      expect(scanDb(empty)).toMatchObject({ status: 2 });
      const usage = `usage: node ${SCAN_SCRIPT} [${DB_ASSETS_SCAN}] <output directory>`;
      for (const scan of [
        runHarnessScan(REPOSITORY, DB_ASSETS_SCAN),
        runHarnessScan(REPOSITORY, dir, [DB_ASSETS_SCAN, "--bundle"]),
        runHarnessScan(REPOSITORY, dir, ["--bundle"]),
      ]) {
        expect([scan.status, scan.stderr.trim()]).toEqual([2, usage]);
      }
    }, 30_000);
  });
});
