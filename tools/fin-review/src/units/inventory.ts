// Units (spec 07 §2.5): every changed file at the reviewed head, less the exclusions of
// docs/review/exclusions.json and binary files, cut into chunks when long.

import { matchesAny } from "../plan/glob.ts";
import type { Glob } from "../plan/glob.ts";
import type { Tier } from "../roles.ts";
import { chunkFile, splitLines } from "./chunk.ts";

export interface Unit {
  readonly id: string;
  readonly path: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  /** The unit's own lines, LF-separated. */
  readonly text: string;
  readonly tier: Tier;
}

export interface Excluded {
  readonly path: string;
  readonly reason: "excluded" | "binary" | "missing";
}

/** True for content no model is sent: a NUL byte in the first 8,000 bytes, or invalid UTF-8. */
export function isBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** Estimated tokens for a text: bytes divided by 3.5 (spec 07 §2.5). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3.5);
}

/**
 * The units of `paths` (each with its tier), reading each file's bytes with `read` (null for a file
 * that is not at the head).
 */
export function inventory(
  paths: ReadonlyArray<{ readonly path: string; readonly tier: Tier }>,
  read: (path: string) => Uint8Array | null,
  exclusions: readonly Glob[],
): { units: Unit[]; excluded: Excluded[] } {
  const units: Unit[] = [];
  const excluded: Excluded[] = [];
  const seen = new Set<string>();
  for (const { path, tier } of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (matchesAny(exclusions, path)) {
      excluded.push({ path, reason: "excluded" });
      continue;
    }
    const bytes = read(path);
    if (bytes === null) {
      excluded.push({ path, reason: "missing" });
      continue;
    }
    if (isBinary(bytes)) {
      excluded.push({ path, reason: "binary" });
      continue;
    }
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    const lines = splitLines(text);
    for (const chunk of chunkFile(path, text)) {
      units.push(
        Object.freeze({
          id: chunk.id,
          path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          totalLines: lines.length,
          text: lines.slice(chunk.startLine - 1, chunk.endLine).join("\n"),
          tier,
        }),
      );
    }
  }
  units.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
  return { units, excluded };
}
