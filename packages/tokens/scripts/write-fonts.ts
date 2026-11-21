// Writes fonts.css: reads a tar of the font files on standard input (`tar -cf - fonts/*.woff2`)
// and prints what scripts/fonts.ts builds from them. `pnpm --filter @fin/tokens fonts` runs it; it
// needs nothing but Node and tar.
import { buildFonts } from "./fonts.ts";

declare const process: {
  stdin: AsyncIterable<Uint8Array>;
  stdout: { write(text: string): boolean };
};

const chunks: Uint8Array<ArrayBuffer>[] = [];
for await (const chunk of process.stdin) chunks.push(new Uint8Array(chunk));
const archive = new Uint8Array(await new Blob(chunks).arrayBuffer());

/** The regular files of a ustar archive, by base name; macOS's AppleDouble entries skipped. */
function untar(bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const text = (from: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(from, from + length)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= bytes.length; ) {
    const name = text(at, 100);
    if (name === "") break;
    const size = Number.parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = text(at + 156, 1);
    const base = name.slice(name.lastIndexOf("/") + 1);
    if ((type === "" || type === "0") && !base.startsWith("._")) {
      files.push({ name: base, bytes: bytes.slice(at + 512, at + 512 + size) });
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

process.stdout.write(await buildFonts(untar(archive)));
