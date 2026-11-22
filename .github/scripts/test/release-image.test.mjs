// release-image.sh: every image of release.yml's matrix is required. Run in a git repository
// holding each image's Dockerfile and build input, with a stand-in docker that logs its calls and
// writes BuildKit's metadata file, and a stand-in date (the runner's GNU date prints milliseconds
// for +%s%3N; BSD date does not).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RELEASE_IMAGES, readImageRecords } from "../release-static.mjs";
import { commit, gitRepo, tempDir, writeTree } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../release-image.sh", import.meta.url));
const SHA = "1".repeat(40);
/** The job token stand-in: it may reach docker only on stdin, never in an argument. */
const TOKEN = ["not", "a", "token", "value"].join("-");
/** The commit time the test repository's commit has (helpers.mjs), SOURCE_DATE_EPOCH's source. */
const COMMIT_TIME = "1795000000";

/** @param {string} image */
const nameOf = (image) => `fin-next-${image}`;
/** @param {string} image the digest the stand-in BuildKit gives this image */
const digestOf = (image) => `sha256:${String(RELEASE_IMAGES.indexOf(image) + 1).repeat(64)}`;
/** @param {string} image */
const dockerfileOf = (image) =>
  image === "connector" ? "ops/docker/connector.Dockerfile" : "ops/docker/app.Dockerfile";
/** @param {string} image the build input release-image.sh checks for */
const inputOf = (image) =>
  image === "connector" ? "apps/connector/package.json" : `apps/${image}/vite.server.config.ts`;
/** @param {string | Buffer} content */
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const DOCKER = `#!/bin/sh
# A stand-in docker CLI. Logs each call with the SOURCE_DATE_EPOCH it sees; takes the login's
# password from stdin; for buildx build, fails when DOCKER_FAIL is set, or writes BuildKit's
# metadata file with DOCKER_DIGEST (no file when DOCKER_META is none).
printf '%s|SOURCE_DATE_EPOCH=%s\\n' "$*" "\${SOURCE_DATE_EPOCH:-}" >> "$DOCKER_LOG"
if [ "$1" = "login" ]; then
  cat > /dev/null
elif [ "$1 $2" = "buildx build" ]; then
  [ -z "\${DOCKER_FAIL:-}" ] || exit 1
  meta=""
  previous=""
  for arg in "$@"; do
    [ "$previous" = "--metadata-file" ] && meta="$arg"
    previous="$arg"
  done
  if [ "\${DOCKER_META:-}" != "none" ]; then
    printf '{"containerimage.digest":"%s"}\\n' "\${DOCKER_DIGEST:-}" > "$meta"
  fi
fi
exit 0
`;
const DATE = "#!/bin/sh\necho 1795000000000\n";

/**
 * A repository on main with every release image's Dockerfile and build input, committed.
 * @param {import("node:test").TestContext} t
 */
function workspace(t) {
  const dir = gitRepo(t);
  /** @type {Record<string, string>} */
  const files = {};
  for (const image of RELEASE_IMAGES) {
    files[dockerfileOf(image)] = "FROM scratch AS release\n";
    files[inputOf(image)] = "{}\n";
  }
  writeTree(dir, files);
  commit(dir);
  return dir;
}

/** @param {string} file */
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/**
 * One leg of the images job: release-image.sh for one IMAGE, as the runner runs it.
 * @param {import("node:test").TestContext} t
 * @param {string} cwd the checkout
 * @param {string} image
 * @param {Record<string, string>} [extra] more environment, for the stand-in docker
 */
function leg(t, cwd, image, extra = {}) {
  const temp = tempDir(t, "fin-ci-runner-");
  const bin = join(temp, "bin");
  writeTree(bin, { docker: DOCKER, date: DATE });
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "date"), 0o755);
  const output = join(temp, "github-output");
  const log = join(temp, "docker.log");
  const run = spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      IMAGE: image,
      GH_TOKEN: TOKEN,
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY: "Owner/fin-next",
      GITHUB_REPOSITORY_OWNER: "Owner",
      GITHUB_ACTOR: "someone",
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: temp,
      DOCKER_LOG: log,
      DOCKER_DIGEST: digestOf(image),
      ...extra,
    },
  });
  const record = join(temp, "image-record", `${nameOf(image)}.json`);
  return {
    status: run.status,
    stdout: run.stdout,
    all: run.stdout + run.stderr,
    outputs: read(output),
    docker: read(log),
    record,
  };
}

/**
 * A step output the leg wrote.
 * @param {string} outputs the GITHUB_OUTPUT file's text
 * @param {string} name
 */
const outputOf = (outputs, name) => new RegExp(`^${name}=(.*)$`, "m").exec(outputs)?.[1];

/**
 * Checks that a leg failed with an error naming its image and what is missing, and left nothing a
 * later step or job could take for an image: no record, no step output, no notice.
 * @param {ReturnType<typeof leg>} run
 * @param {string} image
 * @param {string} what
 * @param {number} [status]
 */
function assertFailed(run, image, what, status = 1) {
  const name = nameOf(image);
  assert.equal(run.status, status, run.all);
  assert.ok(
    run.stdout.includes(`::error title=${name}::${name} is not built: ${what}`),
    `${name}: ${run.all}`,
  );
  assert.match(run.stdout, new RegExp(`^release\\.image name=${name} result=fail ms=\\d+$`, "m"));
  assert.doesNotMatch(run.all, /::notice|built=false|skipped/);
  assert.ok(!existsSync(run.record), `${name}: no record`);
  assert.equal(run.outputs, "", `${name}: no step output`);
}

describe("release-image.sh", () => {
  it("builds, pushes and records each of the six images when its Dockerfile and input are there", (t) => {
    const cwd = workspace(t);
    const downloaded = tempDir(t);
    /** @type {Record<string, string | undefined>} */
    const hashes = {};
    for (const image of RELEASE_IMAGES) {
      const name = nameOf(image);
      const run = leg(t, cwd, image);
      assert.equal(run.status, 0, run.all);
      const bytes = readFileSync(run.record);
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), {
        image: name,
        built: true,
        ref: `ghcr.io/owner/${name}`,
        digest: digestOf(image),
      });
      assert.equal(outputOf(run.outputs, "name"), `ghcr.io/owner/${name}`);
      assert.equal(outputOf(run.outputs, "digest"), digestOf(image));
      assert.equal(outputOf(run.outputs, `record_sha256_${image}`), sha256(bytes));
      assert.equal(outputOf(run.outputs, "built"), undefined, "no image is ever recorded unbuilt");
      assert.match(
        run.stdout,
        new RegExp(
          `^release\\.image name=${name} built=true digest=${digestOf(image)} ms=\\d+$`,
          "m",
        ),
      );
      // Its own Dockerfile's release target, its APP for an app image, the commit's time.
      const build = run.docker.split("\n").find((line) => line.startsWith("buildx build ")) ?? "";
      assert.ok(build.includes(` --file ${dockerfileOf(image)} --target release `), build);
      assert.equal(build.includes(` --build-arg APP=${image} `), image !== "connector", build);
      assert.ok(build.includes(" --build-arg SOURCE_DATE_EPOCH "), build);
      assert.ok(build.endsWith(`|SOURCE_DATE_EPOCH=${COMMIT_TIME}`), build);
      assert.ok(build.includes(`name=ghcr.io/owner/${name},push-by-digest=true`), build);
      assert.ok(!run.docker.includes(TOKEN), "the token reaches docker on stdin only");
      // As the manifest job downloads it.
      writeTree(downloaded, { [`image-record-${image}-${SHA}/${name}.json`]: bytes });
      hashes[image] = outputOf(run.outputs, `record_sha256_${image}`);
    }
    // The six legs' records and outputs are a release the manifest takes, every image in it.
    const read = readImageRecords(downloaded, { sha: SHA, owner: "Owner", hashes });
    assert.deepEqual(
      read.images,
      Object.fromEntries(RELEASE_IMAGES.map((image) => [nameOf(image), digestOf(image)])),
    );
  });

  it("fails the leg, naming the image and its Dockerfile, when the Dockerfile is missing", (t) => {
    const cwd = workspace(t);
    rmSync(join(cwd, "ops", "docker"), { recursive: true });
    for (const image of RELEASE_IMAGES) {
      const run = leg(t, cwd, image);
      assertFailed(run, image, `its Dockerfile ${dockerfileOf(image)} is missing`);
      assert.equal(run.docker, "", "nothing is built or pushed");
    }
  });

  it("fails the leg, naming the image and its input, when its build input is missing", (t) => {
    for (const image of RELEASE_IMAGES) {
      const cwd = workspace(t);
      rmSync(join(cwd, inputOf(image)));
      const run = leg(t, cwd, image);
      assertFailed(run, image, `its build input ${inputOf(image)} is missing`);
      assert.equal(run.docker, "", "nothing is built or pushed");
    }
  });

  it("fails the leg when the build fails or gives no digest", (t) => {
    const cwd = workspace(t);
    /** @type {[string, string, Record<string, string>, string][]} */
    const cases = [
      ["a failed build", "api", { DOCKER_FAIL: "1" }, "the BuildKit build of"],
      ["no digest", "edge", { DOCKER_DIGEST: "" }, "BuildKit gave no image digest"],
      ["a digest that is not one", "verify", { DOCKER_DIGEST: "sha256:abc" }, "BuildKit gave no"],
      ["no metadata file", "connector", { DOCKER_META: "none" }, "BuildKit wrote no metadata file"],
    ];
    for (const [what, image, extra, error] of cases) {
      const run = leg(t, cwd, image, extra);
      assertFailed(run, image, error);
      assert.ok(run.docker.includes("buildx build "), what);
    }
  });

  it("refuses an image outside the matrix: payments and backup are not built by this release", (t) => {
    const cwd = workspace(t);
    for (const image of ["payments", "backup"]) {
      const run = leg(t, cwd, image);
      assert.equal(run.status, 64, run.all);
      assert.ok(
        run.stdout.includes(
          `::error title=release-image::${nameOf(image)} is not a release image of release.yml's matrix`,
        ),
        run.all,
      );
      assert.ok(!existsSync(run.record));
      assert.equal(run.outputs, "");
      assert.equal(run.docker, "");
    }
  });
});
