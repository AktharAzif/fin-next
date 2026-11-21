// public-safety and the pre-push hook, with the planted cases of AC-P0-06. Every planted value is
// built at run time, so this file itself stays clean, and every test that runs the command checks
// that its output never repeats the value it found.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { prePush } from "../pre-push.mjs";
import {
  decodeContent,
  loadRefuseList,
  refuseMatcher,
  scanCommits,
  scanContent,
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
  localPath: ["", "Users", "someone", "notes", "plan.md"].join("/"),
  windowsPath: ["C:", "Users", "someone", "notes"].join("\\"),
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

/**
 * Text as UTF-16 or UTF-32 bytes, with or without a byte-order mark.
 * @param {string} text
 * @param {"utf16le" | "utf16be" | "utf32le" | "utf32be"} encoding
 * @param {boolean} [bom]
 */
function encode(text, encoding, bom = true) {
  if (encoding === "utf16le" || encoding === "utf16be") {
    const bytes = Buffer.from(`${bom ? "\u{FEFF}" : ""}${text}`, "utf16le");
    if (encoding === "utf16be") bytes.swap16();
    return bytes;
  }
  const chars = [...`${bom ? "\u{FEFF}" : ""}${text}`];
  const bytes = Buffer.alloc(chars.length * 4);
  for (const [i, char] of chars.entries()) {
    const code = char.codePointAt(0) ?? 0;
    if (encoding === "utf32le") bytes.writeUInt32LE(code, i * 4);
    else bytes.writeUInt32BE(code, i * 4);
  }
  return bytes;
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
      localPath: "local-path",
      windowsPath: "local-path",
    };
    for (const [key, rule] of Object.entries(expected)) {
      const value = PLANTED[/** @type {keyof typeof PLANTED} */ (key)];
      assert.deepEqual(rules(scanText("f", `const x = "${value}";`, none)), [rule], key);
    }
  });

  test("an account or zone ID is found in upper and mixed case too", () => {
    for (const id of [
      PLANTED.accountId.toUpperCase(),
      `${hex(16, 13)}${hex(16, 5).toUpperCase()}`,
    ]) {
      assert.deepEqual(rules(scanText("f", `const acct="${id}";`, none)), ["account-id"]);
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
      "GET /api/Users/list and https://example.com/Users/list and /Users/Shared/x",
      'route "/users/me", "/users/:id" and "/users/" + id',
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

describe("public-safety reads every encoding", () => {
  const text = `notes\n${PLANTED.staffAddress}\nkey ${PLANTED.token}\nhost ${PLANTED.privateIp}\n`;
  const refused = refuseMatcher([ZONE]);

  test("a NUL byte does not opt a file out of any rule", () => {
    for (const bytes of [
      Buffer.from(`\0${text}`),
      Buffer.from(`notes\0${text}`),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]), Buffer.from(text)]),
    ]) {
      const findings = scanContent("logo.png", bytes, refused);
      assert.deepEqual(rules(findings), ["email-address", "private-ip", "token"]);
      assert.ok(findings.every((f) => f.message.endsWith("(in binary content)")));
    }
  });

  test("UTF-16 and UTF-32 text is decoded, with or without a byte-order mark", () => {
    for (const encoding of /** @type {const} */ (["utf16le", "utf16be", "utf32le", "utf32be"])) {
      for (const bom of [true, false]) {
        const bytes = encode(`${text}console.${ZONE}\n`, encoding, bom);
        assert.deepEqual(
          rules(scanContent("notes16.txt", bytes, refused)),
          ["email-address", "private-ip", "refuse-list", "token"],
          `${encoding} ${bom ? "with" : "without"} a byte-order mark`,
        );
      }
    }
    assert.equal(decodeContent(encode(text, "utf16le")).binary, false);
    assert.equal(decodeContent(Buffer.from(`\u{FEFF}${text}`)).views[0], text);
  });

  test("plain UTF-8 text is read once, as text", () => {
    assert.deepEqual(decodeContent(Buffer.from(text)), { binary: false, views: [text] });
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

  test("binary and UTF-16 files in the tree are scanned, and the command says where", () => {
    const dir = makeRepo({ "a.md": "fine\n" });
    writeFileSync(join(dir, "notes.md"), `\0${PLANTED.staffAddress}\n`);
    writeFileSync(join(dir, "zone16.txt"), encode(`console.${ZONE}\n`, "utf16le"));
    writeFileSync(join(dir, "logo.png"), Buffer.from(`\0\0\0const key="${PLANTED.token}";\n`));
    git(dir, ["add", "-A"]);
    const run = runScript("scripts/public-safety.mjs", ["--root", dir], {
      env: { FIN_OVERLAY_FILE: overlayFile({ refuseList: [ZONE] }) },
    });
    assert.equal(run.status, 1);
    assert.match(run.output, /^notes\.md:1 email-address: .*\(in binary content\)$/m);
    assert.match(run.output, /^zone16\.txt:1 refuse-list: /m);
    assert.match(run.output, /^logo\.png:1 token: /m);
    for (const value of [PLANTED.staffAddress, PLANTED.token, ZONE]) {
      assert.ok(
        !run.output.toLowerCase().includes(value.toLowerCase()),
        "the output repeats a value",
      );
    }
  });

  test("a symbolic link is read as its target, which is what git publishes", () => {
    const dir = makeRepo({ "a.md": "fine\n" });
    symlinkSync(PLANTED.localPath, join(dir, "notes.md"));
    git(dir, ["add", "-A"]);
    assert.deepEqual(rules(scanTree(dir, [])), ["local-path"]);
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

  test("commit mode reads binary content and symbolic links as the tree scan does", () => {
    const dir = makeRepo({ "logo.png": `\0${PLANTED.staffAddress}\n` }, { commit: "add a" });
    symlinkSync(PLANTED.localPath, join(dir, "link.md"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "link"]);
    const commits = git(dir, ["rev-list", "HEAD"]).split("\n").filter(Boolean);
    assert.deepEqual(rules(scanCommits(dir, commits, [])), ["email-address", "local-path"]);
  });

  test("only the two noreply trailer addresses pass in a message", () => {
    const dir = makeRepo({ "a.md": "x\n" });
    const message = (/** @type {string} */ address) => {
      addFiles(dir, { "a.md": `${address}\n`.replace(/@/g, " at ") });
      git(dir, ["commit", "-q", "-m", `change\n\nCo-Authored-By: B <${address}>`]);
      return git(dir, ["rev-parse", "HEAD"]).trim();
    };
    const allowed = [
      ["noreply", "anthropic.com"].join("@"),
      ["12345+someone", "users.noreply.github.com"].join("@"),
    ].map(message);
    assert.deepEqual(scanCommits(dir, allowed, []), []);
    const refused = [
      ["noreply", "fin-staff-mail.co"].join("@"),
      ["NoReply", "private-zone.net"].join("@"),
      ["someone", "evil.users.noreply.github.com"].join("@"),
    ].map(message);
    assert.deepEqual(rules(scanCommits(dir, refused, [])), ["email-address"]);
    assert.equal(scanCommits(dir, refused, []).length, 3);
  });

  test("a merge commit's own changes are scanned, a conflict's resolution included", () => {
    const dir = makeRepo({ "a.txt": "base\n" }, { commit: "base" });
    const base = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["checkout", "-q", "-b", "side"]);
    addFiles(dir, { "a.txt": "side\n" });
    git(dir, ["commit", "-q", "-m", "side"]);
    git(dir, ["checkout", "-q", "work"]);
    addFiles(dir, { "a.txt": "main\n" });
    git(dir, ["commit", "-q", "-m", "main"]);
    assert.throws(() => git(dir, ["merge", "-q", "side", "-m", "merge"])); // a conflict
    addFiles(dir, { "a.txt": `resolved\n${PLANTED.staffAddress}\n`, "b.md": `${PLANTED.token}\n` });
    git(dir, ["commit", "-q", "-m", "merge"]);
    const commits = git(dir, ["rev-list", `${base}..HEAD`])
      .split("\n")
      .filter(Boolean);
    const findings = scanCommits(dir, commits, []);
    const merge = commits[0]?.slice(0, 12);
    assert.deepEqual(findings.map((f) => `${f.file}:${f.line} ${f.rule}`).sort(), [
      `a.txt (commit ${merge}):2 email-address`,
      `b.md (commit ${merge}):1 token`,
    ]);
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
   * @param {{ overlay?: string, localRef?: string, sha?: string, gitleaks?: string }} [options]
   */
  const push = (dir, remoteRef, options = {}) => {
    /** @type {string[]} */
    const lines = [];
    const sha = options.sha ?? git(dir, ["rev-parse", "HEAD"]).trim();
    const code = prePush({
      root: dir,
      remote: "origin",
      input: `${options.localRef ?? "refs/heads/work"} ${sha} ${remoteRef} ${"0".repeat(40)}\n`,
      overlay: options.overlay,
      gitleaks: options.gitleaks ?? "/nonexistent/gitleaks",
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
      const { code, output } = push(dir, "refs/heads/feature", {
        overlay: overlayFile({ refuseList: [ZONE] }),
      });
      assert.equal(code, 1, file);
      assert.match(
        output,
        new RegExp(`^${file.replace(".", "\\.")} \\(commit [0-9a-f]{12}\\):1 `, "m"),
      );
      assert.ok(!output.toLowerCase().includes(content.toLowerCase()), "the hook repeats a value");
    }
  });

  test("a merge whose resolution adds an address is refused", () => {
    const dir = pushable();
    git(dir, ["checkout", "-q", "-b", "side"]);
    addFiles(dir, { "README.md": "side\n" });
    git(dir, ["commit", "-q", "-m", "side"]);
    git(dir, ["checkout", "-q", "work"]);
    addFiles(dir, { "README.md": "main\n" });
    git(dir, ["commit", "-q", "-m", "main"]);
    assert.throws(() => git(dir, ["merge", "-q", "side", "-m", "merge"]));
    addFiles(dir, { "README.md": `resolved\n${PLANTED.staffAddress}\n` });
    git(dir, ["commit", "-q", "-m", "merge"]);
    const { code, output } = push(dir, "refs/heads/feature");
    assert.equal(code, 1);
    assert.match(output, /^README\.md \(commit [0-9a-f]{12}\):2 email-address: /m);
    assert.match(output, /scanned 3 commit\(s\)/);
  });

  test("an annotated tag's message and a pushed ref's name are scanned", () => {
    const dir = pushable();
    git(dir, [
      "-c",
      "tag.gpgsign=false",
      "tag",
      "-a",
      "v1",
      "-m",
      `release for ${PLANTED.staffAddress}`,
    ]);
    const tag = git(dir, ["rev-parse", "v1"]).trim();
    const tagged = push(dir, "refs/tags/v1", { localRef: "refs/tags/v1", sha: tag });
    assert.equal(tagged.code, 1);
    assert.match(tagged.output, /^pushed ref #1 \(tag message\):1 email-address: /m);
    assert.match(tagged.output, /scanned 0 commit\(s\)/);
    const named = push(dir, `refs/heads/${PLANTED.staffAddress}`);
    assert.equal(named.code, 1);
    assert.match(named.output, /^pushed ref #1 email-address: .*\(in the pushed ref's name\)$/m);
    assert.ok(!`${tagged.output}${named.output}`.includes(PLANTED.staffAddress));
  });

  test("a ref that does not point at a commit is refused", () => {
    const dir = pushable();
    const blob = git(dir, ["rev-parse", "HEAD:README.md"]).trim();
    const { code, output } = push(dir, "refs/tags/blob", { localRef: "refs/tags/blob", sha: blob });
    assert.equal(code, 1);
    assert.match(output, /does not point at a commit/);
  });

  test("gitleaks reads merges too", () => {
    const dir = pushable();
    addFiles(dir, { "b.md": "fine\n" });
    git(dir, ["commit", "-q", "-m", "b"]);
    const bin = mkdtempSync(join(tmpdir(), "fin-gitleaks-"));
    const record = join(bin, "args.txt");
    const fake = join(bin, "gitleaks");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${record}'\n`);
    chmodSync(fake, 0o755);
    const { code } = push(dir, "refs/heads/feature", { gitleaks: fake });
    assert.equal(code, 0);
    const args = readFileSync(record, "utf8").split("\n");
    assert.ok(
      args.some((a) =>
        /^--log-opts=--diff-merges=first-parent [0-9a-f]{40} --not --remotes=origin$/.test(a),
      ),
      args.join(" "),
    );
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
