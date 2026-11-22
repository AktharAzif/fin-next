// Reads a static artefact's zip archive (the GitHub Actions artifact release.yml uploads and attests
// as `static-<key>-<sha>`) into memory, with Node built-ins only, after its attestation and SHA-256
// were verified, so the build that is rendered is exactly the archive that was attested.
//
// Only what an artefact needs is accepted, and anything else is refused rather than guessed at:
// stored or deflated entries; plain relative paths (no `..`, no absolute path, no backslash, no
// unusual character) named once; regular files and directories only (no link, no device); no
// encryption, no zip64, no multi-disk archive; at most MAX_FILES files, each at most the 25 MiB
// asset limit, MAX_TOTAL bytes in all; and every entry's size and CRC-32 as its header says.

import { crc32, inflateRawSync } from "node:zlib";

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipFile {
  /** The path inside the archive, without a leading slash: `assets/main-abc.js`. */
  path: string;
  data: Buffer;
}

const SEGMENT = /^[A-Za-z0-9._@~+=,-]+$/;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function checkPath(name: string): { path: string; directory: boolean } {
  const directory = name.endsWith("/");
  const path = directory ? name.slice(0, -1) : name;
  if (path === "" || path.startsWith("/") || path.includes("\\"))
    throw new ZipError(`the archive holds an unsafe path`);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || !SEGMENT.test(segment))
      throw new ZipError(`the archive holds an unsafe or unusual path (${JSON.stringify(path)})`);
  }
  return { path, directory };
}

/** The archive's files, in archive order. */
export function readZip(archive: Buffer): ZipFile[] {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (
    eocd < 0 ||
    archive.length - eocd < 22 ||
    eocd + 22 + archive.readUInt16LE(eocd + 20) !== archive.length
  )
    throw new ZipError("not a zip archive (no end of central directory)");
  const disk = archive.readUInt16LE(eocd + 4);
  const cdDisk = archive.readUInt16LE(eocd + 6);
  const onDisk = archive.readUInt16LE(eocd + 8);
  const total = archive.readUInt16LE(eocd + 10);
  const cdSize = archive.readUInt32LE(eocd + 12);
  const cdOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total)
    throw new ZipError("a multi-disk archive is refused");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipError("a zip64 archive is refused");
  if (cdOffset + cdSize > eocd) throw new ZipError("the central directory is out of bounds");
  if (total > MAX_FILES) throw new ZipError(`the archive holds more than ${MAX_FILES} entries`);

  const files: ZipFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let at = cdOffset;
  for (let i = 0; i < total; i++) {
    if (at + 46 > eocd || archive.readUInt32LE(at) !== 0x02014b50)
      throw new ZipError("a central directory entry is malformed");
    const madeBy = archive.readUInt16LE(at + 4);
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const external = archive.readUInt32LE(at + 38);
    const localOffset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (at > eocd) throw new ZipError("a central directory entry is out of bounds");

    if ((flags & 0x1) !== 0) throw new ZipError("an encrypted entry is refused");
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new ZipError("a zip64 entry is refused");
    const { path, directory } = checkPath(name);
    if (madeBy >> 8 === 3) {
      const type = (external >>> 16) & S_IFMT;
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR)
        throw new ZipError(`${path} is not a regular file (a link or a device)`);
      if (type === S_IFDIR && !directory) throw new ZipError(`${path} is a directory entry`);
    }
    if (directory) continue;
    if (seen.has(path)) throw new ZipError(`${path} appears twice in the archive`);
    seen.add(path);
    if (size > MAX_FILE_BYTES) throw new ZipError(`${path} is over the 25 MiB asset limit`);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new ZipError(`the archive unpacks to more than ${MAX_TOTAL_BYTES} bytes`);

    if (localOffset + 30 > cdOffset || archive.readUInt32LE(localOffset) !== 0x04034b50)
      throw new ZipError(`${path}: the local header is malformed`);
    const start =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    if (start + compressed > cdOffset) throw new ZipError(`${path}: the data is out of bounds`);
    const raw = archive.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) {
      if (compressed !== size) throw new ZipError(`${path}: a stored entry's sizes differ`);
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new ZipError(`${path}: the data does not inflate to its stated size`);
      }
    } else {
      throw new ZipError(`${path}: compression method ${method} is refused`);
    }
    if (data.length !== size) throw new ZipError(`${path}: the size differs from its header`);
    if (crc32(data) !== crc) throw new ZipError(`${path}: the CRC-32 differs from its header`);
    files.push({ path, data });
  }
  return files;
}
