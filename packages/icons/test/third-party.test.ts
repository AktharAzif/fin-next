// The third-party licences (spec 06 §3.4): each is its own file in licenses/, byte for byte the
// upstream release's, as THIRD_PARTY.json lists it with the upstream file's SHA-256; NOTICE.md
// points to each and holds no licence text itself.
import { describe, expect, it } from "vitest";
import circleFlags from "../licenses/circle-flags-2.8.3.LICENSE.md?raw";
import phosphor from "../licenses/phosphor-icons-react-2.1.10.LICENSE?raw";
import web3icons from "../licenses/web3icons-core-4.0.58.LICENCE?raw";
import notice from "../NOTICE.md?raw";
import listText from "../THIRD_PARTY.json?raw";

type Entry = {
  path: string;
  package: string;
  version: string;
  upstreamPath: string;
  sha256: string;
};

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

  it("lists every licence file once, with its package, exact version and upstream file", () => {
    expect(list.map((e) => e.path).sort()).toEqual(Object.keys(FILES).sort());
    for (const entry of list) {
      expect(Object.keys(entry).sort(), entry.path).toEqual(
        ["package", "path", "sha256", "upstreamPath", "version"].sort(),
      );
      expect(entry.version, entry.path).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.path, entry.path).toContain(entry.version);
      expect(entry.sha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
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
