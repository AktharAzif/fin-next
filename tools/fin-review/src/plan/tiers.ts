// Tiers from tools/layout.json (spec 07 §2.4; spec 01 §4.3; ARCHITECTURE §3.1).
//
// A path's tier is S when it is a control path or no entry maps it. Otherwise the entry with the
// longest path prefix (whole segments) maps it, and the first glob of that entry's `tiers` map
// that matches the path below the entry decides; an entry with a single `tier` uses that, and an
// entry whose globs all miss gives S. Matching ignores ASCII case (glob.ts's foldAscii, the one
// fold of the planner), and a path with a character outside printable ASCII is S, since a disk
// that folds more than ASCII may read it as any path (glob.ts). The root entry (path "" or ".")
// maps files at the repository root, only those it lists in `files` when it has that list. A
// control path written as a folder (`docs/review/`) covers the folder's own path as well as
// everything below it, so a file or link put in the folder's place is a control path too.

import { shownText } from "../display.ts";
import { isJsonObject } from "../json.ts";
import { isTier } from "../roles.ts";
import type { Tier } from "../roles.ts";
import { compileGlob, foldAscii, globError, isPlainPath, matchesAny } from "./glob.ts";
import type { Glob } from "./glob.ts";

/** An image name (one repository path component), as release.yml pushes it. */
const IMAGE_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** A static output's name, as release.yml names its artefact. */
const STATIC_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface LayoutEntry {
  /** The entry's path as written, without a trailing slash; "" for the root entry. */
  readonly path: string;
  /** The path's segments with ASCII case folded, for prefix matching. */
  readonly segments: readonly string[];
  readonly isRoot: boolean;
  readonly name: string | null;
  readonly kind: string | null;
  readonly image: string | null;
  readonly static: readonly string[];
  readonly tiers: ReadonlyArray<{ readonly glob: Glob; readonly tier: Tier }>;
  readonly tier: Tier | null;
  /** The root entry's listed files, ASCII case folded; null when it lists none. */
  readonly files: ReadonlySet<string> | null;
}

export interface Layout {
  readonly entries: readonly LayoutEntry[];
  readonly controlPaths: readonly Glob[];
}

/**
 * Where a path's tier came from. `not-documentation` is a path the layout calls D that is not a
 * documentation file (plan.ts): tier D is documentation (EXECUTION §1.7), so it counts as S.
 * `not-plain` is a path with a character outside printable ASCII (glob.ts's isPlainPath).
 */
export type TierSource = "control" | "entry" | "entry-default" | "unmapped" | "no-layout" | "not-documentation" | "not-plain";

export interface PathTier {
  readonly tier: Tier;
  readonly source: TierSource;
  readonly entry: LayoutEntry | null;
}

const TIER_RANK: Readonly<Record<Tier, number>> = { D: 0, N: 1, S: 2 };

/** The higher of two tiers (S above N above D). */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

function entryPathError(path: string): string | null {
  if (path.includes("\0")) return "holds a NUL byte";
  if (path.startsWith("/")) return "is absolute";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return "has an empty, . or .. segment";
    if (segment.includes("*") || segment.includes("?")) return "is a glob, not a path";
  }
  return null;
}

/** Validates tools/layout.json. Unknown keys are allowed: the file serves several checkers. */
export function parseLayout(value: unknown): { ok: true; value: Layout } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  if (value["version"] !== 1) errors.push("version must be 1");
  const controlPaths: Glob[] = [];
  const rawControl = value["controlPaths"];
  if (!Array.isArray(rawControl)) errors.push("controlPaths must be an array");
  else {
    rawControl.forEach((item, index) => {
      if (typeof item !== "string" || item === "") {
        errors.push(`controlPaths[${index}] must be a non-empty string`);
        return;
      }
      // `dir/` is the folder's own path and everything below it.
      const patterns = item.endsWith("/") ? [item.slice(0, -1), `${item}**`] : [item];
      for (const pattern of patterns) {
        const problem = globError(pattern);
        if (problem !== null) {
          errors.push(`controlPaths[${index}]: ${problem}`);
          return;
        }
      }
      for (const pattern of patterns) controlPaths.push(compileGlob(pattern));
    });
  }
  const entries: LayoutEntry[] = [];
  const rawEntries = value["entries"];
  const seenPaths = new Set<string>();
  if (!Array.isArray(rawEntries)) errors.push("entries must be an array");
  else {
    rawEntries.forEach((raw, index) => {
      const where = `entries[${index}]`;
      if (!isJsonObject(raw)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const rawPath = raw["path"];
      if (typeof rawPath !== "string") {
        errors.push(`${where}.path must be a string`);
        return;
      }
      const kind = raw["kind"];
      const trimmed = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      const isRoot = trimmed === "" || trimmed === "." || kind === "root";
      const path = isRoot ? "" : trimmed;
      if (isRoot && trimmed !== "" && trimmed !== ".") {
        errors.push(`${where} is the root entry, so its path must be "" or "."`);
        return;
      }
      if (!isRoot) {
        const problem = entryPathError(path);
        if (problem !== null) {
          errors.push(`${where}.path ${problem}`);
          return;
        }
      }
      const key = foldAscii(path);
      if (seenPaths.has(key)) errors.push(`${where}.path ${shownText(path)} appears twice`);
      seenPaths.add(key);

      for (const field of ["name", "kind", "image"] as const) {
        if (Object.hasOwn(raw, field) && typeof raw[field] !== "string") errors.push(`${where}.${field} must be a string`);
      }
      // Images and static outputs reach the plan document and release.yml's names, so they keep
      // to a narrow grammar.
      const rawImage = raw["image"];
      if (typeof rawImage === "string" && !IMAGE_RE.test(rawImage)) {
        errors.push(`${where}.image ${shownText(rawImage, 140)} is not an image name (lower-case letters, digits, . _ -)`);
      }
      let statics: string[] = [];
      const rawStatic = raw["static"];
      if (typeof rawStatic === "string") statics = [rawStatic];
      else if (Array.isArray(rawStatic) && rawStatic.every((item) => typeof item === "string" && item !== "")) {
        statics = rawStatic as string[];
      } else if (Object.hasOwn(raw, "static")) errors.push(`${where}.static must be a string or an array of strings`);
      for (const output of statics) {
        if (!STATIC_RE.test(output)) errors.push(`${where}.static ${shownText(output, 80)} is not a static output name (lower-case letters, digits, -)`);
      }

      const tiers: Array<{ glob: Glob; tier: Tier }> = [];
      let tier: Tier | null = null;
      const rawTier = raw["tier"];
      if (Object.hasOwn(raw, "tier")) {
        if (isTier(rawTier)) tier = rawTier;
        else errors.push(`${where}.tier must be S, N or D`);
      }
      const rawTiers = raw["tiers"];
      if (isTier(rawTiers)) tier ??= rawTiers;
      else if (isJsonObject(rawTiers)) {
        for (const glob of Object.keys(rawTiers)) {
          // Integer-like keys would be reordered by JavaScript, losing "the first glob that matches".
          if (/^[0-9]+$/.test(glob)) {
            errors.push(`${where}.tiers key ${shownText(glob)} is integer-like and would lose its order`);
            continue;
          }
          const problem = globError(glob);
          const value = rawTiers[glob];
          if (problem !== null) errors.push(`${where}.tiers: ${problem}`);
          else if (!isTier(value)) errors.push(`${where}.tiers[${shownText(glob)}] must be S, N or D`);
          else tiers.push({ glob: compileGlob(glob), tier: value });
        }
      } else if (Object.hasOwn(raw, "tiers")) errors.push(`${where}.tiers must be an object of glob to tier`);

      let files: Set<string> | null = null;
      if (Object.hasOwn(raw, "files")) {
        const rawFiles = raw["files"];
        if (!isRoot) errors.push(`${where}.files is only for the root entry`);
        else if (!Array.isArray(rawFiles) || !rawFiles.every((item) => typeof item === "string" && item !== "" && !item.includes("/"))) {
          errors.push(`${where}.files must be an array of root file names`);
        } else files = new Set(rawFiles.map((item) => foldAscii(item as string)));
      }
      const name = raw["name"];
      const image = raw["image"];
      entries.push(
        Object.freeze({
          path,
          segments: path === "" ? [] : foldAscii(path).split("/"),
          isRoot,
          name: typeof name === "string" ? name : null,
          kind: typeof kind === "string" ? kind : null,
          image: typeof image === "string" ? image : null,
          static: Object.freeze(statics),
          tiers: Object.freeze(tiers),
          tier,
          files,
        }),
      );
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: Object.freeze({ entries: Object.freeze(entries), controlPaths: Object.freeze(controlPaths) }) };
}

/** The entry with the longest path prefix that maps `path`, or null. */
export function entryOf(layout: Layout, path: string): LayoutEntry | null {
  const segments = path.split("/");
  const lower = segments.map(foldAscii);
  let best: LayoutEntry | null = null;
  for (const entry of layout.entries) {
    if (entry.isRoot) {
      if (segments.length !== 1) continue;
      if (entry.files !== null && !entry.files.has(lower[0] ?? "")) continue;
      if (best === null) best = entry;
      continue;
    }
    if (entry.segments.length > lower.length) continue;
    let match = true;
    for (let i = 0; i < entry.segments.length; i++) {
      if (entry.segments[i] !== lower[i]) {
        match = false;
        break;
      }
    }
    if (match && (best === null || best.segments.length < entry.segments.length)) best = entry;
  }
  return best;
}

/** The path below `entry` that its tier globs are matched against. */
function relativeTo(entry: LayoutEntry, path: string): string {
  const segments = path.split("/");
  if (entry.isRoot) return path;
  if (segments.length === entry.segments.length) return segments[segments.length - 1] ?? path;
  return segments.slice(entry.segments.length).join("/");
}

/**
 * The tier of one path (spec 07 §2.4). With no valid layout every path is S, and so is a path with
 * a character outside printable ASCII, whatever entry or glob it resembles.
 */
export function tierOf(layout: Layout | null, path: string): PathTier {
  if (layout === null) return { tier: "S", source: "no-layout", entry: null };
  if (!isPlainPath(path)) return { tier: "S", source: "not-plain", entry: null };
  if (matchesAny(layout.controlPaths, path)) return { tier: "S", source: "control", entry: entryOf(layout, path) };
  const entry = entryOf(layout, path);
  if (entry === null) return { tier: "S", source: "unmapped", entry: null };
  const relative = relativeTo(entry, path);
  for (const { glob, tier } of entry.tiers) {
    if (glob.test(relative)) return { tier, source: "entry", entry };
  }
  if (entry.tier !== null) return { tier: entry.tier, source: "entry", entry };
  return { tier: "S", source: "entry-default", entry };
}
