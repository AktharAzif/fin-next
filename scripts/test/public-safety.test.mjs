// public-safety and the pre-push hook, with the planted cases of AC-P0-06. Every planted value is
// built at run time, so this file itself stays clean, and every test that runs the command checks
// that its output never repeats the value it found.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { prePush } from "../pre-push.mjs";
import {
  decodeContent,
  foldText,
  loadRefuseList,
  refuseMatcher,
  scanCommits,
  scanContent,
  scanName,
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
    assert.deepEqual(decodeContent(Buffer.from(text)), {
      binary: false,
      views: [text],
      texts: [text],
    });
  });

  test("a byte-order mark, or another encoding after the first page, hides nothing", () => {
    const payload = `contact ${PLANTED.personalAddress}\nacct ${PLANTED.accountId}\nhost console.${ZONE}\n`;
    const utf16le = (/** @type {string} */ s) => Buffer.from(s, "utf16le");
    const expected = ["account-id", "email-address", "refuse-list"];
    assert.deepEqual(rules(scanContent("notes.txt", Buffer.from(payload), refused)), expected);
    for (const [form, bytes] of /** @type {[string, Buffer][]} */ ([
      ["FF FE, then UTF-8", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload)])],
      ["FE FF, then UTF-8", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(payload)])],
      [
        "EF BB BF, then UTF-16LE",
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf16le(payload)]),
      ],
      [
        "8193 ASCII bytes, then UTF-16LE",
        Buffer.concat([Buffer.from("x".repeat(8193)), utf16le(payload)]),
      ],
      [
        "88 lines of ASCII, then UTF-16LE",
        Buffer.concat([Buffer.from(`${"y".repeat(99)}\n`.repeat(88)), utf16le(payload)]),
      ],
      [
        "FF FE 41, then UTF-16LE at an odd offset",
        Buffer.concat([Buffer.from([0xff, 0xfe, 0x41]), utf16le(payload)]),
      ],
      ["UTF-16BE without a mark", encode(payload, "utf16be", false)],
    ])) {
      assert.deepEqual(rules(scanContent("notes.txt", bytes, refused)), expected, form);
    }
  });
});

describe("public-safety matches the refuse list across lines and separators", () => {
  const refused = refuseMatcher(["Jane Q Public", ["oldproduct-zone", "invalid"].join(".")]);
  const found = (/** @type {string} */ text) =>
    scanText("a.md", text, refused).map((f) => `${f.line} ${f.rule} ${f.message.slice(-2)}`);

  test("a wrap, a run of spaces or an invisible character between its words hides no entry", () => {
    for (const text of [
      "see Jane Q\nPublic",
      "see Jane Q\r\nPublic",
      "see Jane Q\n    // Public",
      "see Jane Q\n * Public",
      "see Jane Q\n> Public",
      "see Jane\u{A0}Q\u{2003}Public",
      "see Jane  Q\t\tPublic",
      "see Jane Q\u{200B} Public",
      "see \u{FF2A}\u{FF41}\u{FF4E}\u{FF45} Q Public",
    ]) {
      assert.deepEqual(found(text), ["1 refuse-list #1"], JSON.stringify(text));
    }
  });

  test("an escape, a soft hyphen, a defanged dot or a hyphenated wrap hides no entry", () => {
    for (const text of [
      "see oldproduct\\-zone.invalid",
      "see oldproduct\u{AD}-zone.invalid",
      "see oldproduct-zone[.]invalid",
      "see oldproduct-zone(.)invalid",
      "see oldproduct-\nzone.invalid",
      "see OLDPRODUCT-ZONE.INVALID",
    ]) {
      assert.deepEqual(found(text), ["1 refuse-list #2"], JSON.stringify(text));
    }
  });

  test("a match across lines is reported once, at the line where it starts", () => {
    assert.deepEqual(found("one\ntwo\nsee Jane Q\nPublic\nthree\n"), ["3 refuse-list #1"]);
    assert.deepEqual(found("Jane Q Public and Jane Q\nPublic"), ["1 refuse-list #1"]);
    assert.deepEqual(found("Jane Q.\nPublic and Jane Public Q"), []);
  });

  test("the folding keeps every line's number", () => {
    for (const join of [false, true]) {
      const view = foldText("ab  \n\n  // cd\r\nEF", join);
      assert.equal(view.text, join ? "abcdef" : "ab cd ef");
      assert.deepEqual(
        [...view.text].map((_, i) => view.lineAt(i)).filter((_, i) => view.text.charAt(i) !== " "),
        [1, 1, 3, 3, 4, 4],
      );
    }
  });

  test("names, messages and paths are matched the same way", () => {
    assert.deepEqual(rules(scanText("m", "release notes for Jane Q\nPublic", refused)), [
      "refuse-list",
    ]);
    assert.deepEqual(rules(scanName(["notes", "Jane\u{200B}Q Public.md"].join("/"), refused)), []);
    assert.deepEqual(rules(scanName("notes/Jane\u{200B} Q Public.md", refused)), ["refuse-list"]);
  });
});

describe("public-safety refuses encoded files end to end", () => {
  test("the command and the pre-push hook find a value behind a byte-order mark", () => {
    const remote = mkdtempSync(join(tmpdir(), "fin-remote-"));
    git(remote, ["init", "-q", "--bare"]);
    const dir = makeRepo({ "README.md": "x\n" }, { commit: "root" });
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["push", "-q", "origin", "work"]);
    writeFileSync(
      join(dir, "notes.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`contact ${PLANTED.staffAddress}\n`)]),
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "notes"]);
    const tree = runScript("scripts/public-safety.mjs", ["--root", dir]);
    assert.equal(tree.status, 1);
    assert.match(tree.output, /^notes\.txt:1 email-address: /m);
    const range = runScript("scripts/public-safety.mjs", ["--root", dir, "--range", "HEAD"]);
    assert.equal(range.status, 1);
    /** @type {string[]} */
    const lines = [];
    const code = prePush({
      root: dir,
      remote: "origin",
      input: `refs/heads/work ${git(dir, ["rev-parse", "HEAD"]).trim()} refs/heads/feature ${"0".repeat(40)}\n`,
      gitleaks: "/nonexistent/gitleaks",
      log: (line) => lines.push(line),
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /^notes\.txt \(commit [0-9a-f]{12}\):1 email-address: /m);
    for (const output of [tree.output, range.output, lines.join("\n")]) {
      assert.ok(!output.includes(PLANTED.staffAddress), "the output repeats a value");
    }
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

  test("a tracked file is read as git stores it, and its working tree copy where it differs", () => {
    const dir = makeRepo({
      "staged.md": `mail ${PLANTED.staffAddress}\n`,
      "edited.md": "fine\n",
      "deleted.md": `key ${PLANTED.token}\n`,
      "same.md": `host ${PLANTED.privateIp}\n`,
    });
    writeFileSync(join(dir, "staged.md"), "clean now, but not staged\n");
    writeFileSync(join(dir, "edited.md"), `fine\nhost ${PLANTED.privateIp}\n`);
    rmSync(join(dir, "deleted.md"));
    const found = scanTree(dir, []).map((f) => `${f.file}:${f.line} ${f.rule} ${f.message}`);
    assert.equal(found.length, 4, found.join("\n"));
    assert.match(found[0] ?? "", /^deleted\.md:1 token .*\(in the copy git has staged\)$/);
    assert.match(found[1] ?? "", /^edited\.md:2 private-ip .*\(in the working tree, not staged\)$/);
    assert.match(found[2] ?? "", /^same\.md:1 private-ip .*address$/);
    assert.match(found[3] ?? "", /^staged\.md:1 email-address .*\(in the copy git has staged\)$/);
  });

  test("a working-tree-encoding attribute does not hide what git publishes", (t) => {
    // IBM037 (EBCDIC) for the characters of `staff: <address>`, as a checkout would write it.
    const ebcdic = (/** @type {string} */ text) =>
      Buffer.from(
        [...text].map((c) => {
          const code = c.charCodeAt(0);
          if (c >= "a" && c <= "i") return 0x81 + code - 0x61;
          if (c >= "j" && c <= "r") return 0x91 + code - 0x6a;
          if (c >= "s" && c <= "z") return 0xa2 + code - 0x73;
          if (c >= "0" && c <= "9") return 0xf0 + code - 0x30;
          return { " ": 0x40, ".": 0x4b, "-": 0x60, ":": 0x7a, "@": 0x7c, "\n": 0x25 }[c] ?? 0x6f;
        }),
      );
    const dir = makeRepo({ ".gitattributes": "leak.txt working-tree-encoding=IBM037\n" });
    writeFileSync(join(dir, "leak.txt"), ebcdic(`staff: ${PLANTED.staffAddress}\n`));
    try {
      git(dir, ["add", "-A"]);
    } catch {
      t.skip("this git cannot convert IBM037");
      return;
    }
    assert.equal(git(dir, ["show", ":leak.txt"]), `staff: ${PLANTED.staffAddress}\n`);
    const run = runScript("scripts/public-safety.mjs", ["--root", dir]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /^leak\.txt:1 email-address: /m);
    assert.ok(!run.output.includes(PLANTED.staffAddress), "the output repeats a value");
  });

  test("a byte-order mark or text after the first page hides nothing in the tree or a commit", () => {
    const payload = `mail ${PLANTED.staffAddress}\nhost console.${ZONE}\n`;
    const files = {
      "ff-fe.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload)]),
      "fe-ff.txt": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(payload)]),
      "utf32-mark.txt": Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from(payload)]),
      "late16.txt": Buffer.concat([
        Buffer.from(`${"x".repeat(9090)}\n`),
        Buffer.from(payload, "utf16le"),
      ]),
      "late16be.txt": Buffer.concat([
        Buffer.from(`${"y".repeat(8193)}\n`),
        encode(payload, "utf16be", false),
      ]),
    };
    const dir = makeRepo({ "a.md": "fine\n" });
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "encoded"]);
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    const perFile = (/** @type {{ file: string, rule: string }[]} */ findings) =>
      Object.keys(files).map((name) =>
        rules(findings.filter((f) => f.file.split(" ")[0] === name)).join(","),
      );
    const expected = Object.keys(files).map(() => "email-address,refuse-list");
    assert.deepEqual(perFile(scanTree(dir, [ZONE])), expected);
    assert.deepEqual(perFile(scanCommits(dir, [head], [ZONE])), expected);
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

  test("a refused value typed while resolving a merge is found, though no other commit has it", () => {
    const dir = makeRepo({ "a.txt": "base\n" }, { commit: "base" });
    const base = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["checkout", "-q", "-b", "side"]);
    addFiles(dir, { "a.txt": "side\n" });
    git(dir, ["commit", "-q", "-m", "side"]);
    git(dir, ["checkout", "-q", "work"]);
    addFiles(dir, { "a.txt": "main\n" });
    git(dir, ["commit", "-q", "-m", "main"]);
    assert.throws(() => git(dir, ["merge", "-q", "side", "-m", "merge"]));
    addFiles(dir, { "a.txt": `resolved for console.${ZONE}\n` });
    git(dir, ["commit", "-q", "-m", "merge"]);
    const commits = git(dir, ["rev-list", `${base}..HEAD`])
      .split("\n")
      .filter(Boolean);
    const merge = commits[0]?.slice(0, 12);
    assert.deepEqual(
      scanCommits(dir, commits, [ZONE]).map((f) => `${f.file}:${f.line} ${f.rule}`),
      [`a.txt (commit ${merge}):1 refuse-list`],
    );
    // The same commits without the merge hold nothing refused.
    assert.deepEqual(scanCommits(dir, commits.slice(1), [ZONE]), []);
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

  test("a merge whose resolution adds a refused value is refused, and the value not printed", () => {
    const dir = pushable();
    git(dir, ["checkout", "-q", "-b", "side"]);
    addFiles(dir, { "README.md": "side\n" });
    git(dir, ["commit", "-q", "-m", "side"]);
    git(dir, ["checkout", "-q", "work"]);
    addFiles(dir, { "README.md": "main\n" });
    git(dir, ["commit", "-q", "-m", "main"]);
    assert.throws(() => git(dir, ["merge", "-q", "side", "-m", "merge"]));
    addFiles(dir, { "README.md": `resolved for console.${ZONE}\n` });
    git(dir, ["commit", "-q", "-m", "merge"]);
    const overlay = overlayFile({ refuseList: [ZONE] });
    const { code, output } = push(dir, "refs/heads/feature", { overlay });
    assert.equal(code, 1);
    assert.match(output, /^README\.md \(commit [0-9a-f]{12}\):1 refuse-list: /m);
    assert.ok(!output.toLowerCase().includes(ZONE.toLowerCase()), "the hook repeats a value");
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
