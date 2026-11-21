// Entry point: `node tools/fin-review/src/main.ts <command> [options]` (spec 07 §2.1).
// Importing this module does nothing; running it as the main module runs the CLI.
//
// It is also the bootstrap of the engine-copy check (src/review/engine-copy.ts). Before any other
// engine module loads, it hashes its own file and registers a synchronous, in-thread load hook that
// records the git blob ID of each module's source as Node loads it (the bytes on the disk at that
// moment, before type stripping). The check compares those IDs with the engine's commit, so a module
// edited before the start and put back before the check is still found. To keep every other engine
// module behind the hook, this file imports only node:* built-ins and loads the CLI afterwards.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/** The blob ID git gives `bytes` (src/git.ts's gitBlobId, repeated so that no engine module loads before the hook). */
function blobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function sourceBytes(source: unknown): Uint8Array | null {
  if (typeof source === "string") return Buffer.from(source, "utf8");
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return null;
}

/**
 * Starts recording what Node loads from now on: every file: module's URL with the blob ID of the
 * source Node was given for it (an empty string when it was given none, which no commit matches).
 * The hook is synchronous and in-thread, so no module loads unrecorded once this returns.
 */
export function recordModules(): Map<string, string> {
  const loaded = new Map<string, string>();
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.startsWith("file:")) {
        const bytes = sourceBytes(result.source);
        loaded.set(url, bytes === null ? "" : blobId(bytes));
      }
      return result;
    },
  });
  return loaded;
}

/** Runs the CLI against this process and sets its exit code. */
export async function main(): Promise<void> {
  // This file was loaded before any hook could see it: it hashes itself first.
  const own = blobId(readFileSync(fileURLToPath(import.meta.url)));
  const loadedModules = recordModules();
  loadedModules.set(import.meta.url, own);
  const { runCli } = await import("./cli.ts");
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    configDir: fileURLToPath(new URL("../config/", import.meta.url)),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    loadedModules,
  });
}

if (import.meta.main) await main();
