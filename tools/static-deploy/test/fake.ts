// A fake of the Cloudflare endpoints an assets-only upload uses, shaped like SP-26's answers. It
// records each call, keeps the uploaded assets by hash, and builds the script's state from the one
// metadata part it is given, so a test sees exactly what a real upload would leave behind.

import type { FetchFn } from "../src/cloudflare.ts";

export const ACCOUNT = "1".repeat(32);

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
