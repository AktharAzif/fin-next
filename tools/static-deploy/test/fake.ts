// A fake of the Cloudflare endpoints an assets-only upload uses, shaped like SP-26's answers. It
// records each call, keeps the uploaded assets by hash, and builds the script's state from the one
// metadata part it is given, so a test sees exactly what a real upload would leave behind.
//
// FakeGh stands in for the `gh` CLI: `gh attestation verify` behaves as gh 2.102 does for the flags
// the deploy passes (an exact, case-sensitive certificate identity; the source commit), and
// `gh api` answers the two GitHub Actions reads the merge-job check makes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FetchFn } from "../src/cloudflare.ts";
import type { ExecResult } from "../src/provenance.ts";

export const ACCOUNT = "1".repeat(32);

/** The repository as GitHub writes it, and release.yml's certificate identity on main. */
export const REPOSITORY = "AktharAzif/fin-next";
export const RELEASE_SAN = `https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`;

export class FakeGh {
  readonly calls: string[][] = [];
  /** The SubjectAlternativeName release.yml's certificates carry. */
  san = RELEASE_SAN;
  /** The event of the run that signed (`push` for a real release). */
  trigger = "push";
  /** The commit the attestations were built from; undefined means whichever commit is asked. */
  builtFrom: string | undefined;
  /** SHA-256s of the files with an attestation (anything else does not verify). */
  readonly attestedFiles = new Set<string>();
  /** Image subjects (`oci://...`) with no attestation. */
  readonly unattestedImages = new Set<string>();
  /** The merge job's conclusion; undefined means ci.yml has no run for the commit. */
  mergeConclusion: string | undefined = "success";

  attest(bytes: Buffer | string): void {
    this.attestedFiles.add(createHash("sha256").update(bytes).digest("hex"));
  }

  readonly exec = (program: string, args: readonly string[]): ExecResult => {
    this.calls.push([program, ...args]);
    const fail = (stderr: string): ExecResult => ({ status: 1, stdout: "", stderr });
    if (program !== "gh") return { status: 127, stdout: "", stderr: "not found" };
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
    if (args[0] === "attestation" && args[1] === "verify") {
      const subject = args[2] ?? "";
      if (subject.startsWith("oci://")) {
        if (this.unattestedImages.has(subject)) return fail("no attestations found");
      } else {
        let digest: string;
        try {
          digest = createHash("sha256").update(readFileSync(subject)).digest("hex");
        } catch {
          return fail("file not found");
        }
        if (!this.attestedFiles.has(digest)) return fail("no attestations found");
      }
      if (flag("--repo")?.toLowerCase() !== REPOSITORY.toLowerCase())
        return fail("no attestations found");
      // gh compares --cert-identity with the certificate's SAN exactly, case included.
      if (flag("--cert-identity") !== this.san) return fail("verifying with issuer");
      const asked = flag("--source-digest");
      const built = this.builtFrom ?? asked;
      if (asked !== undefined && asked !== built)
        return fail(`expected SourceRepositoryDigest to be ${asked}, got ${built}`);
      if (flag("--format") !== "json") return { status: 0, stdout: "", stderr: "" };
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            attestation: {},
            verificationResult: {
              signature: {
                certificate: {
                  subjectAlternativeName: this.san,
                  buildTrigger: this.trigger,
                  sourceRepositoryDigest: built,
                  sourceRepositoryRef: "refs/heads/main",
                },
              },
            },
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "api") {
      const path = args.at(-1) ?? "";
      const runs = new RegExp(
        `^repos/${REPOSITORY}/actions/workflows/ci\\.yml/runs\\?head_sha=([0-9a-f]{40})&event=push&branch=main`,
      ).exec(path);
      if (runs !== null) {
        const runList =
          this.mergeConclusion === undefined
            ? []
            : [
                {
                  id: 101,
                  head_sha: runs[1],
                  head_branch: "main",
                  event: "push",
                  path: ".github/workflows/ci.yml",
                  status: "completed",
                  conclusion: this.mergeConclusion,
                },
              ];
        return { status: 0, stdout: JSON.stringify({ workflow_runs: runList }), stderr: "" };
      }
      if (new RegExp(`^repos/${REPOSITORY}/actions/runs/101/jobs`).test(path)) {
        return {
          status: 0,
          stdout: JSON.stringify({
            jobs: [
              { name: "check", status: "completed", conclusion: "success" },
              { name: "merge", status: "completed", conclusion: this.mergeConclusion },
            ],
          }),
          stderr: "",
        };
      }
      return fail("HTTP 404: Not Found");
    }
    return fail("unknown command");
  };
}

export interface FakeScript {
  id: string;
  has_modules: boolean;
  has_assets: boolean;
  handlers: string[];
  metadata: Record<string, unknown>;
  parts: string[];
  subdomain: { enabled: boolean; previews_enabled: boolean };
  bindings: unknown[];
}

export class FakeStatic {
  readonly token: string;
  readonly calls: Array<{ method: string; path: string; auth: string }> = [];
  readonly stored = new Map<string, { type: string; base64: string }>();
  readonly scripts = new Map<string, FakeScript>();
  accounts = [{ id: ACCOUNT }];
  uploadToken = `upload${"U".repeat(20)}`;

  constructor(token: string) {
    this.token = token;
  }

  readonly fetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/client\/v4/, "");
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization") ?? "";
    this.calls.push({ method, path: `${path}${u.search}`, auth });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
    const fail = (status: number, message: string) =>
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 10000, message }], result: null }),
        { status },
      );
    const scripts = `/accounts/${ACCOUNT}/workers/scripts`;

    if (path === `/accounts/${ACCOUNT}/workers/assets/upload` && method === "POST") {
      if (auth !== `Bearer ${this.uploadToken}`) return fail(401, "bad upload token");
      if (u.searchParams.get("base64") !== "true") return fail(400, "base64 expected");
      const form = init.body as FormData;
      for (const [hash, value] of form.entries()) {
        const blob = value as Blob;
        this.stored.set(hash, { type: blob.type, base64: await blob.text() });
      }
      return ok({ jwt: `completion${"C".repeat(20)}` });
    }
    if (auth !== `Bearer ${this.token}`) return fail(403, "Authentication error");
    if (path === "/accounts" && method === "GET") return ok(this.accounts);
    if (path === scripts && method === "GET") {
      return ok(
        [...this.scripts.values()].map((s) => ({
          id: s.id,
          has_modules: s.has_modules,
          has_assets: s.has_assets,
          handlers: s.handlers,
        })),
      );
    }
    const m = new RegExp(`^${scripts}/([a-z0-9-]+)(/[a-z-]+)?$`).exec(path);
    if (m === null) return fail(404, `no route for ${method} ${path}`);
    const name = m[1] ?? "";
    const tail = m[2] ?? "";
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    if (tail === "/assets-upload-session" && method === "POST") {
      const manifest = (body?.manifest ?? {}) as Record<string, { hash: string; size: number }>;
      const missing = Object.values(manifest)
        .map((f) => f.hash)
        .filter((h) => !this.stored.has(h));
      return ok({ jwt: this.uploadToken, buckets: missing.length === 0 ? [] : [missing] });
    }
    if (tail === "" && method === "PUT") {
      const form = init.body as FormData;
      const parts = [...form.keys()];
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<
        string,
        unknown
      >;
      const assets = metadata.assets as { jwt?: string } | undefined;
      if (!assets?.jwt?.startsWith("completion") && assets?.jwt !== this.uploadToken)
        return fail(400, "bad completion token");
      const hasModule =
        parts.some((p) => p !== "metadata") || "main_module" in metadata || "body_part" in metadata;
      const previous = this.scripts.get(name);
      this.scripts.set(name, {
        id: name,
        has_modules: hasModule,
        has_assets: true,
        handlers: hasModule ? ["fetch"] : [],
        metadata,
        parts,
        subdomain: previous?.subdomain ?? { enabled: true, previews_enabled: true },
        bindings: (metadata.bindings as unknown[]) ?? [],
      });
      return ok({ id: name, has_assets: true, has_modules: hasModule });
    }
    const script = this.scripts.get(name);
    if (script === undefined) return fail(404, "no such script");
    if (tail === "/subdomain" && method === "POST") {
      script.subdomain = {
        enabled: body?.enabled === true,
        previews_enabled: body?.previews_enabled === true,
      };
      return ok(script.subdomain);
    }
    if (tail === "/subdomain" && method === "GET") return ok(script.subdomain);
    if (tail === "/settings" && method === "GET") {
      return ok({
        bindings: script.bindings,
        compatibility_date: script.metadata.compatibility_date,
      });
    }
    return fail(404, `no route for ${method} ${path}`);
  };
}
