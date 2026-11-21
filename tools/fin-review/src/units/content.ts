// What a file's bytes are, checked by content and never by name alone (spec 07 §2.5). A name is
// the pull request author's to choose, so a file is excluded from the units only when its bytes are
// what docs/review/exclusions.json's globs say: an image or a font (by its magic bytes), the pnpm
// lockfile, or a source map. Anything else is reviewed, or, when it cannot be, counted as a file no
// lens saw.

import { posix } from "node:path";

export type ContentKind = "image" | "font" | "lockfile" | "sourcemap";

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp"]);
const FONT_EXTENSIONS: ReadonlySet<string> = new Set(["woff", "woff2", "ttf", "otf", "eot"]);
const BMP_HEADER_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 108, 124]);
const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024;

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((value, index) => bytes[at + index] === value);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  if (bytes.length < to) return "";
  let out = "";
  for (let i = from; i < to; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function isBmp(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 2) !== "BM" || bytes.length < 18) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(2, true) === bytes.length && BMP_HEADER_SIZES.has(view.getUint32(14, true));
}

/** "image" or "font" when the bytes start as one of the formats exclusions.json names; else null. */
export function mediaKind(bytes: Uint8Array): "image" | "font" | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image";
  if (ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12))) return "image";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 22) return "image"; // ICO
  if (isBmp(bytes)) return "image";
  if (["wOFF", "wOF2", "OTTO", "true"].includes(ascii(bytes, 0, 4))) return "font";
  if (startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) && bytes.length >= 12) return "font"; // TrueType
  if (bytes.length > 36 && bytes[34] === 0x4c && bytes[35] === 0x50) return "font"; // EOT's magic "LP"
  return null;
}

function isLockfile(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 64)).toString("utf8");
  return /^(?:﻿)?lockfileVersion: /.test(head);
}

function isSourceMap(bytes: Uint8Array): boolean {
  if (bytes.length > MAX_SOURCE_MAP_BYTES) return false;
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const map = value as Record<string, unknown>;
    return map["version"] === 3 && typeof map["mappings"] === "string";
  } catch {
    return false;
  }
}

/**
 * The kind of content `path`'s name claims, when the bytes are that kind: an image or font
 * extension with that format's magic bytes, `pnpm-lock.yaml` that starts as a pnpm lockfile, a
 * `.map` that is a source map. Null otherwise, so an excluded name alone never hides a file.
 */
export function verifiedExclusion(path: string, bytes: Uint8Array): ContentKind | null {
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  const extension = dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return mediaKind(bytes) === "image" ? "image" : null;
  if (FONT_EXTENSIONS.has(extension)) return mediaKind(bytes) === "font" ? "font" : null;
  if (base === "pnpm-lock.yaml") return isLockfile(bytes) ? "lockfile" : null;
  if (extension === "map") return isSourceMap(bytes) ? "sourcemap" : null;
  return null;
}
