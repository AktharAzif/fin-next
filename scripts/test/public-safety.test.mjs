// public-safety and the pre-push hook, with the planted cases of AC-P0-06. Every planted value is
// built at run time, so this file itself stays clean, and every test that runs the command checks
// that its output never repeats the value it found.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { prePush } from "../pre-push.mjs";
import {
  loadRefuseList,
  refuseMatcher,
  scanCommits,
  scanText,
  scanTree,
} from "../public-safety.mjs";
import { addFiles, cleanUp, git, makeRepo, REPO_ROOT, rules, runScript } from "./helpers.mjs";

after(cleanUp);

const none = () => [];
const hex = (/** @type {number} */ n, /** @type {number} */ seed = 7) =>
  Array.from({ length: n }, (_, i) => "0123456789abcdef".charAt((i * seed + 3) % 16)).join("");
const alnum = (/** @type {number} */ n) =>
  Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2sT4vW6yZ8".charAt((i * 5 + 1) % 27)).join(
    "",
  );

const PLANTED = {
  staffAddress: ["ops.lead", "fin-staff-mail.co"].join("@"),
  personalAddress: ["someone", ["mail", "provider", "net"].join(".")].join("@"),
  token: `fin_${"live"}_${alnum(32)}`,
  tunnelId: [hex(8), hex(4, 3), hex(4, 5), hex(4, 9), hex(12, 11)].join("-"),
  accountId: hex(32, 13),
  privateIp: ["10", "20", "30", "40"].join("."),
  uniqueLocal: ["fd12", "3456", "789a", "", "1"].join(":"),
  artifact: ["claude.ai", "artifact", `${alnum(8)}-${hex(4)}`].join("/"),
  pem: `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
  credentialUrl: `postgres://fin:${alnum(20)}@localhost:5432/fin`,
  tunnelToken: Buffer.from(JSON.stringify({ a: hex(32), t: "x", s: alnum(40) })).toString("base64"),
};
// A stand-in for a zone name from the overlay (the real one never appears in the repository).
const ZONE = ["fin-staging-zone", "invalid"].join(".");

/**
 * Writes an overlay file outside any repository.
 * @param {unknown} content
 */
function overlayFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "fin-overlay-"));
  const file = join(dir, "overlay.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

describe("public-safety rules", () => {
  test("each planted shape is found by its rule", () => {
    const expected = {
      staffAddress: "email-address",
      personalAddress: "email-address",
      token: "token",
      tunnelId: "tunnel-id",
      accountId: "account-id",
      privateIp: "private-ip",
      uniqueLocal: "private-ip",
      artifact: "claude-artifact",
      pem: "token",
      credentialUrl: "token",
      tunnelToken: "token",
    };
    for (const [key, rule] of Object.entries(expected)) {
      const value = PLANTED[/** @type {keyof typeof PLANTED} */ (key)];
      assert.deepEqual(rules(scanText("f", `const x = "${value}";`, none)), [rule], key);
    }
  });

  test("allowed look-alikes pass", () => {
    for (const text of [
      `owner ${["dev", "example.com"].join("@")} and ${["a", "mail.example.org"].join("@")}`,
      "pnpm@12.21.0, @biomejs/biome@2.6.8, vitest@5.1.0(@types/node@26.6.6)",
      `sha256:${hex(64)} and commit ${hex(40)}`,
      "00000000-0000-0000-0000-000000000000",
      "the private ranges 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and fc00::/7",
      "listen on 127.0.0.1:5432 and [::1]",
      "fin_test_ (a prefix alone), whsec_ and AGE-SECRET-KEY-1",
      "version 1.10.2.3 is not an address",
      // Two lines of the plan: a placeholder DSN on a reserved name, and a scrubber pattern.
      `dsn: "https://${["fin", "relay.invalid"].join("@")}/1"`,
      "| `postgres(ql)?://[^:/\\s]+:[^@\\s]+@` | `postgres://[login]:[secret]@` |",
    ]) {
      assert.deepEqual(scanText("f", text, none), [], text);
    }
  });

  test("the refuse list matches case-insensitively, and a commit SHA by any 7+ prefix", () => {
    const sha = hex(40, 3);
    const refused = refuseMatcher([ZONE, sha]);
    assert.deepEqual(refused(`https://console.${ZONE.toUpperCase()}/x`), [1]);
    assert.deepEqual(refused(`port of ${sha.slice(0, 7)}`), [2]);
    assert.deepEqual(refused(`port of ${sha.slice(0, 6)}`), []);
    assert.deepEqual(refused("nothing here"), []);
  });

  test("an invalid overlay fails closed without printing its contents", () => {
    const secret = `${ZONE}-content`;
    assert.throws(
      () => loadRefuseList(overlayFile(`{"refuseList": ["${secret}"`)),
      (error) => {
        assert.ok(error instanceof Error && !error.message.includes(secret));
        return true;
      },
    );
    assert.throws(() => loadRefuseList(overlayFile({ refuse: [secret] })), /refuseList/);
    assert.throws(() => loadRefuseList(overlayFile({ refuseList: ["ab"] })), /entry #1/);
    assert.throws(() => loadRefuseList("/nonexistent/overlay.json"), /does not exist/);
    assert.deepEqual(loadRefuseList(undefined), []);
  });
});

describe("public-safety over a repository", () => {
  test("a clean repository passes, and so does this one", () => {
    assert.deepEqual(scanTree(makeRepo({ "a.md": "fine\n" }), []), []);
    assert.deepEqual(scanTree(REPO_ROOT, []), []);
  });

  test("planted values fail with file:line and the rule, never the value", () => {
    const overlay = overlayFile({ refuseList: [ZONE] });
    const dir = makeRepo({
      "docs/a.md": `ok\nmail ${PLANTED.staffAddress}\n`,
      "src/b.ts": `const t = "${PLANTED.token}";\nconst id = "${PLANTED.tunnelId}";\n`,
      "ops/c.json": `{ "host": "console.${ZONE}" }\n`,
    });
    const run = runScript("scripts/public-safety.mjs", ["--root", dir], {
      env: { FIN_OVERLAY_FILE: overlay },
    });
    assert.equal(run.status, 1);
    assert.match(run.output, /^docs\/a\.md:2 email-address: /m);
    assert.match(run.output, /^src\/b\.ts:1 token: /m);
    assert.match(run.output, /^src\/b\.ts:2 tunnel-id: /m);
    assert.match(
      run.output,
      /^ops\/c\.json:1 refuse-list: matches the overlay's refuse list entry #1$/m,
    );
    for (const value of [PLANTED.staffAddress, PLANTED.token, PLANTED.tunnelId, ZONE]) {
      assert.ok(
        !run.output.toLowerCase().includes(value.toLowerCase()),
        "the output repeats a value",
      );
    }
  });

  test("a refused value in a file's path is found", () => {
    const dir = makeRepo({ [`notes/${ZONE}.md`]: "x\n" });
    assert.deepEqual(rules(scanTree(dir, [ZONE])), ["refuse-list"]);
  });

  test("only tracked files are scanned", () => {
    const dir = makeRepo({ "a.md": "fine\n" });
    writeFileSync(join(dir, "untracked.md"), `${PLANTED.token}\n`);
    assert.deepEqual(scanTree(dir, []), []);
  });

  test("an unreadable overlay makes the command exit 2", () => {
    const run = runScript("scripts/public-safety.mjs", ["--root", makeRepo({})], {
      env: { FIN_OVERLAY_FILE: "/nonexistent/o.json" },
    });
    assert.equal(run.status, 2);
  });

  test("commit mode finds a value a later commit removed, and one in a message", () => {
    const dir = makeRepo({ "a.md": `${PLANTED.privateIp}\n` }, { commit: "add a" });
    const first = git(dir, ["rev-parse", "HEAD"]).trim();
    addFiles(dir, { "a.md": "clean\n" });
    git(dir, [
      "commit",
      "-q",
      "-m",
      `tidy for ${PLANTED.personalAddress}\n\nCo-Authored-By: Bot <${["noreply", "bot.invalid"].join("@")}>`,
    ]);
    const second = git(dir, ["rev-parse", "HEAD"]).trim();
    assert.deepEqual(scanTree(dir, []), []);
    const findings = scanCommits(dir, [first, second], []);
    assert.deepEqual(
      findings.map((f) => `${f.file} ${f.rule}`),
      [
        `a.md (commit ${first.slice(0, 12)}) private-ip`,
        `commit ${second.slice(0, 12)} (message) email-address`,
      ],
    );
  });
});

describe("the pre-push hook refuses the same", () => {
  /** A repository with a bare remote that already has the first commit. */
  function pushable() {
    const remote = mkdtempSync(join(tmpdir(), "fin-remote-"));
    git(remote, ["init", "-q", "--bare"]);
    const dir = makeRepo({ "README.md": "x\n" }, { commit: "root" });
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["push", "-q", "origin", "work"]);
    return dir;
  }

  /**
   * @param {string} dir
   * @param {string} remoteRef
   * @param {string} [overlay]
   */
  const push = (dir, remoteRef, overlay) => {
    /** @type {string[]} */
    const lines = [];
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const code = prePush({
      root: dir,
      remote: "origin",
      input: `refs/heads/work ${head} ${remoteRef} ${"0".repeat(40)}\n`,
      overlay,
      gitleaks: "/nonexistent/gitleaks",
      log: (line) => lines.push(line),
    });
    return { code, output: lines.join("\n") };
  };

  test("a clean push passes, and says gitleaks was not found", () => {
    const dir = pushable();
    addFiles(dir, { "b.md": "fine\n" });
    git(dir, ["commit", "-q", "-m", "b"]);
    const { code, output } = push(dir, "refs/heads/feature");
    assert.equal(code, 0);
    assert.match(output, /scanned 1 commit\(s\)/);
    assert.match(output, /gitleaks is not installed/);
  });

  test("a planted address, token, tunnel ID or refused zone name is refused, and not printed", () => {
    for (const [file, content] of /** @type {[string, string][]} */ ([
      ["a.md", PLANTED.staffAddress],
      ["b.ts", PLANTED.token],
      ["c.json", PLANTED.tunnelId],
      ["d.md", `console.${ZONE}`],
    ])) {
      const dir = pushable();
      addFiles(dir, { [file]: `${content}\n` });
      git(dir, ["commit", "-q", "-m", "plant"]);
      const { code, output } = push(dir, "refs/heads/feature", overlayFile({ refuseList: [ZONE] }));
      assert.equal(code, 1, file);
      assert.match(
        output,
        new RegExp(`^${file.replace(".", "\\.")} \\(commit [0-9a-f]{12}\\):1 `, "m"),
      );
      assert.ok(!output.toLowerCase().includes(content.toLowerCase()), "the hook repeats a value");
    }
  });

  test("only the commits the remote does not have are scanned", () => {
    const dir = pushable();
    const { code, output } = push(dir, "refs/heads/feature");
    assert.equal(code, 0);
    assert.match(output, /scanned 0 commit\(s\)/);
  });

  test("a push to main is refused", () => {
    const dir = pushable();
    assert.equal(push(dir, "refs/heads/main").code, 1);
  });

  test("the command reads git's pre-push input and exits 1 on a finding", () => {
    const dir = pushable();
    addFiles(dir, { "e.md": `${PLANTED.accountId}\n` });
    git(dir, ["commit", "-q", "-m", "plant"]);
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const run = runScript("scripts/pre-push.mjs", ["origin"], {
      cwd: dir,
      input: `refs/heads/work ${head} refs/heads/feature ${"0".repeat(40)}\n`,
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.equal(run.status, 1);
    assert.match(run.output, /^e\.md \(commit [0-9a-f]{12}\):1 account-id: /m);
  });
});
