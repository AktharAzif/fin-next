// CRC-32 (IEEE 802.3, the reflected polynomial 0xEDB88320 that zlib uses), table-driven in plain
// TypeScript so the docs site's Try-it guard runs it in a browser (spec 05 §4.1, §9). T05-01 compares
// it with node:zlib's crc32 over 10,000 random inputs. Browser-safe: this file imports nothing.

let table: Uint32Array | null = null;

/** The 256-entry table, built on first use (never at module scope). */
function crcTable(): Uint32Array {
  if (table !== null) return table;
  const built = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    built[n] = c >>> 0;
  }
  table = built;
  return built;
}

/** The unsigned CRC-32 of the bytes. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (t[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The unsigned CRC-32 of an ASCII string's bytes; a character above 0x7f is refused. */
export function crc32Ascii(text: string): number {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new RangeError("crc32Ascii takes ASCII text only");
    bytes[i] = code;
  }
  return crc32(bytes);
}
