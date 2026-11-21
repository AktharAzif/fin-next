// The third-party licences (spec 06 §3.4): each is its own file in licenses/, byte for byte the
// upstream file, as THIRD_PARTY.json lists it with that file's SHA-256; NOTICE.md points to each
// and holds no licence text itself.
//
// An entry takes one of two forms. Normally the licence comes from the npm release itself, and
// `upstreamPath` names the file inside the release's tarball. When the release ships no licence or
// notice file, the narrow form the steward allowed (21 Nov) applies instead: `url` is the
// project's own file as a raw GitHub file at a 40-hex commit, and `tag` records the release tag
// that names that commit. Either way the copy here is compared by SHA-256.
import { describe, expect, it } from "vitest";
import circleFlags from "../licenses/circle-flags-2.8.3.LICENSE.md?raw";
import phosphor from "../licenses/phosphor-icons-react-2.1.10.LICENSE?raw";
import web3icons from "../licenses/web3icons-core-4.0.58.LICENCE?raw";
import notice from "../NOTICE.md?raw";
import listText from "../THIRD_PARTY.json?raw";

type ReleaseEntry = {
  path: string;
  package: string;
  version: string;
  upstreamPath: string;
  sha256: string;
};

type CommitEntry = {
  path: string;
  package: string;
  version: string;
  url: string;
  tag: string;
  sha256: string;
};

type Entry = ReleaseEntry | CommitEntry;

const RELEASE_KEYS = ["package", "path", "sha256", "upstreamPath", "version"].sort();
const COMMIT_KEYS = ["package", "path", "sha256", "tag", "url", "version"].sort();

// A file inside the npm tarball, never a URL.
const TARBALL_PATH = /^package\/[^/\s][^\s]*$/;
// A raw GitHub licence or notice file pinned to a full 40-hex commit, never a branch or tag name.
const RAW_AT_COMMIT =
  /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\/(?:[\w.-]+\/)*(?:LICEN[CS]E|NOTICE)(?:\.[\w]+)?$/;

const FILES: Record<string, string> = {
  "licenses/phosphor-icons-react-2.1.10.LICENSE": phosphor,
  "licenses/circle-flags-2.8.3.LICENSE.md": circleFlags,
  "licenses/web3icons-core-4.0.58.LICENCE": web3icons,
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("THIRD_PARTY.json", () => {
  const list = JSON.parse(listText) as Entry[];

  it("lists every licence file once, with its package, exact version and SHA-256", () => {
    expect(list.map((e) => e.path).sort()).toEqual(Object.keys(FILES).sort());
    for (const entry of list) {
      expect(entry.version, entry.path).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.path, entry.path).toContain(entry.version);
      expect(entry.sha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("names the file in the release's tarball, or a raw file at a commit with its release tag", () => {
    for (const entry of list) {
      const keys = Object.keys(entry).sort();
      if ("upstreamPath" in entry) {
        expect(keys, entry.path).toEqual(RELEASE_KEYS);
        expect(entry.upstreamPath, entry.path).toMatch(TARBALL_PATH);
      } else {
        expect(keys, entry.path).toEqual(COMMIT_KEYS);
        expect(entry.url, entry.path).toMatch(RAW_AT_COMMIT);
        // The tag names the release itself, at its exact version.
        expect(
          [`${entry.package}@${entry.version}`, `v${entry.version}`, entry.version],
          entry.path,
        ).toContain(entry.tag);
      }
    }
  });

  it("holds each licence byte for byte as the upstream file whose SHA-256 it records", async () => {
    for (const entry of list) {
      expect(await sha256(FILES[entry.path] ?? ""), entry.path).toBe(entry.sha256);
    }
  });

  it("is what NOTICE.md points to, and NOTICE.md copies no licence text", () => {
    for (const entry of list) expect(notice, entry.path).toContain(`\`${entry.path}\``);
    expect(notice).not.toMatch(/Permission is hereby granted/);
    expect(notice).not.toMatch(/THE SOFTWARE IS PROVIDED/);
  });
});
