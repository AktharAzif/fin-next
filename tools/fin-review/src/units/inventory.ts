// Units (spec 07 §2.5): every changed file at the reviewed head, cut into chunks when long, less the
// files that are not sent to a model. What is left out, and why, is decided by content:
//
// - a code file (.ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs) is always a unit, whatever its name
//   or bytes, because Node runs such a file with a NUL or a stray byte in it;
// - a file whose path matches docs/review/exclusions.json is excluded only when its bytes are what
//   the name says (an image or font by its magic bytes, the pnpm lockfile, a source map);
// - a file with a NUL in its first 8,000 bytes (git's own rule) is binary and is not a unit;
// - every other file is a unit, its bytes decoded as UTF-8 with any invalid sequence replaced,
//   so one stray byte cannot take a text file out of the review;
// - a symbolic link is a unit whose text is its target; a submodule is never a unit.
//
// Every changed path that yields no unit is reported, with its reason and what its content was
// verified to be, so the run can name it to the lenses and block on it (src/review/run.ts).

import { CODE_FILE_RE } from "../plan/graph.ts";
import { matchesAny } from "../plan/glob.ts";
import type { Glob } from "../plan/glob.ts";
import type { Tier } from "../roles.ts";
import { chunkFile, splitLines } from "./chunk.ts";
import { mediaKind, verifiedExclusion } from "./content.ts";
import type { ContentKind } from "./content.ts";

export type UnitKind = "file" | "link";

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
  /** A symbolic link's unit holds the link's target. */
  readonly kind: UnitKind;
}

export interface UnitSource {
  readonly path: string;
  readonly tier: Tier;
  /** What the path is at the head; null when the head has no such path. */
  readonly kind: UnitKind | "submodule" | null;
}

export type ExcludedReason = "excluded" | "binary" | "missing" | "submodule";

export interface Excluded {
  readonly path: string;
  readonly reason: ExcludedReason;
  readonly tier: Tier;
  /** What the bytes were verified to be, or null when they are none of the kinds never sent to a model. */
  readonly content: ContentKind | null;
}

/** Bytes git itself calls binary: a NUL in the first 8,000 (never for a code file). */
export function isBinary(path: string, bytes: Uint8Array): boolean {
  if (CODE_FILE_RE.test(path)) return false;
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * A file's text as the engine reviews it and sessions are shown it: UTF-8 with every invalid
 * sequence and every NUL replaced by U+FFFD (lines keep their numbers; CRLF is left to the caller).
 */
export function decodeText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8").replace(/\0/g, "�");
}

/** Estimated tokens for a text: bytes divided by 3.5 (spec 07 §2.5). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3.5);
}

/** True when a changed path that yields no unit must block: nothing could review it (spec 07 §2.11 rule 6). */
export function blocksCoverage(item: Excluded): boolean {
  if (item.reason === "missing") return true;
  if (item.reason === "excluded" || item.content !== null) return false;
  return item.tier === "S" || item.tier === "N";
}

/**
 * The units of `paths` (each with its tier and kind at the head), reading each file's bytes with
 * `read` (null when they cannot be read), and every path that yields none.
 */
export function inventory(
  paths: readonly UnitSource[],
  read: (path: string) => Uint8Array | null,
  exclusions: readonly Glob[],
): { units: Unit[]; excluded: Excluded[] } {
  const units: Unit[] = [];
  const excluded: Excluded[] = [];
  const seen = new Set<string>();
  for (const { path, tier, kind } of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (kind === "submodule") {
      excluded.push({ path, reason: "submodule", tier, content: null });
      continue;
    }
    const bytes = kind === null ? null : read(path);
    if (bytes === null) {
      excluded.push({ path, reason: "missing", tier, content: null });
      continue;
    }
    if (kind === "file" && !CODE_FILE_RE.test(path)) {
      const verified = matchesAny(exclusions, path) ? verifiedExclusion(path, bytes) : null;
      if (verified !== null) {
        excluded.push({ path, reason: "excluded", tier, content: verified });
        continue;
      }
      if (isBinary(path, bytes)) {
        excluded.push({ path, reason: "binary", tier, content: mediaKind(bytes) });
        continue;
      }
    }
    const text = decodeText(bytes);
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
          kind: kind === "link" ? "link" : "file",
        }),
      );
    }
  }
  units.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
  return { units, excluded };
}
