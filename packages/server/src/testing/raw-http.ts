// Test helpers: a request written byte for byte on a socket, for what fetch() would never send (a
// dot segment, a backslash, `*`, a missing or malformed Host). Imported only by *.test.ts files.
import { connect } from "node:net";

export interface RawAnswer {
  status: number;
  /** Header names in lower case; a repeated header's values joined with ", ". */
  headers: Record<string, string>;
  body: string;
}

function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < body.length) {
    const end = body.indexOf("\r\n", at);
    if (end === -1) break;
    const size = Number.parseInt(body.subarray(at, end).toString("latin1"), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(body.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/**
 * Sends `head` (the request line and headers, each ending in CRLF), the blank line and `body`, and
 * reads the whole answer (send `Connection: close` so the server ends it).
 */
export function rawRequest(
  port: number,
  head: string,
  body = "",
  host = "127.0.0.1",
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ port, host }, () => socket.write(`${head}\r\n${body}`));
    socket.setTimeout(5000, () => socket.destroy(new Error("no answer within 5 s")));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      const lines = all
        .subarray(0, split === -1 ? all.length : split)
        .toString("latin1")
        .split("\r\n");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
      }
      const rest = split === -1 ? Buffer.alloc(0) : all.subarray(split + 4);
      const body = headers["transfer-encoding"] === "chunked" ? dechunk(rest) : rest;
      resolve({ status, headers, body: body.toString("utf8") });
    });
  });
}
