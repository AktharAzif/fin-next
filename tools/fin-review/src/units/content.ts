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

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** An ICO file: reserved 0, type 1, 1 to 255 images whose directory entries lie within the file. */
function isIco(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || bytes.length < 22) return false;
  const v = view(bytes);
  const count = v.getUint16(4, true);
  const directory = 6 + 16 * count;
  if (count < 1 || count > 255 || bytes.length < directory) return false;
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const size = v.getUint32(entry + 8, true);
    const offset = v.getUint32(entry + 12, true);
    if (bytes[entry + 3] !== 0 || size === 0 || offset < directory || offset + size > bytes.length) return false;
  }
  return true;
}

/** An sfnt font (TrueType, OpenType): 1 to 512 tables whose records lie past the directory and within the file. */
function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = ascii(bytes, 0, 4);
  if (tag !== "OTTO" && tag !== "true" && !startsWith(bytes, [0x00, 0x01, 0x00, 0x00])) return false;
  const v = view(bytes);
  const tables = v.getUint16(4);
  const directory = 12 + 16 * tables;
  if (tables < 1 || tables > 512 || bytes.length < directory) return false;
  for (let i = 0; i < tables; i++) {
    const record = 12 + 16 * i;
    const offset = v.getUint32(record + 8);
    const length = v.getUint32(record + 12);
    if (offset < directory || offset + length > bytes.length) return false;
  }
  return true;
}

/** WOFF and WOFF2: the signature and a header whose length field is the file's length. */
function isWoff(bytes: Uint8Array): boolean {
  const tag = ascii(bytes, 0, 4);
  if ((tag !== "wOFF" && tag !== "wOF2") || bytes.length < 44) return false;
  const v = view(bytes);
  return v.getUint32(8) === bytes.length && v.getUint16(12) >= 1;
}

/** EOT: its size field is the file's length, a known version, and the magic number 0x504C at 34. */
function isEot(bytes: Uint8Array): boolean {
  if (bytes.length < 82) return false;
  const v = view(bytes);
  const version = v.getUint32(8, true);
  return (
    v.getUint32(0, true) === bytes.length &&
    v.getUint32(4, true) <= bytes.length &&
    (version === 0x00010000 || version === 0x00020001 || version === 0x00020002) &&
    v.getUint16(34, true) === 0x504c
  );
}

/**
 * "image" or "font" when the bytes are laid out as one of the formats exclusions.json names; else
 * null. It is only ever asked together with the name (verifiedExclusion): a few planted magic bytes
 * at the start of any file never make it media.
 */
export function mediaKind(bytes: Uint8Array): "image" | "font" | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image";
  if (ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12))) return "image";
  if (isIco(bytes)) return "image";
  if (isBmp(bytes)) return "image";
  if (isWoff(bytes) || isSfnt(bytes) || isEot(bytes)) return "font";
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
