// Cutting a long file into units (spec 07 §2.5): a file over 1,200 lines is cut into chunks of whole
// top-level declarations of at most 1,200 lines. In .ts, .tsx, .js and .mjs a declaration starts at
// column 0 with export, function, async function, class, const, let, interface, type or enum;
// Markdown is cut at `## ` headings; JSON, YAML and every other file are never cut. A declaration
// longer than 1,200 lines is a chunk alone. The unit ID is the path, or `<path>#<first declaration
// name>` for a chunk.

export const MAX_UNIT_LINES = 1200;

export interface Chunk {
  /** The unit ID. */
  readonly id: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

const CODE_EXT_RE = /\.(?:ts|tsx|js|mjs)$/i;
const MD_EXT_RE = /\.md$/i;
const DECLARATION_START_RE = /^(?:export\b|function\b|async\s+function\b|class\s|const\s|let\s|interface\s|type\s|enum\s)/;
const DECLARATION_NAME_RE =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** The lines of `text` after CRLF becomes LF; a final newline does not start another line. */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface Boundary {
  readonly line: number; // 0-based
  readonly name: string;
}

function boundaries(path: string, lines: readonly string[]): Boundary[] | null {
  const out: Boundary[] = [];
  if (CODE_EXT_RE.test(path)) {
    lines.forEach((line, index) => {
      if (!DECLARATION_START_RE.test(line)) return;
      out.push({ line: index, name: DECLARATION_NAME_RE.exec(line)?.[1] ?? `L${index + 1}` });
    });
    return out;
  }
  if (MD_EXT_RE.test(path)) {
    lines.forEach((line, index) => {
      if (line.startsWith("## ")) {
        const slug = line
          .slice(3)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60);
        out.push({ line: index, name: slug === "" ? `L${index + 1}` : slug });
      }
    });
    return out;
  }
  return null;
}

/** The units of one file. */
export function chunkFile(path: string, text: string): Chunk[] {
  const lines = splitLines(text);
  const total = Math.max(1, lines.length);
  if (lines.length <= MAX_UNIT_LINES) return [{ id: path, startLine: 1, endLine: total }];
  const found = boundaries(path, lines);
  if (found === null || found.length === 0) return [{ id: path, startLine: 1, endLine: total }];
  // Segments: [start of a declaration, start of the next); the lines before the first declaration
  // (imports, a header) join the first segment.
  const segments: Array<{ start: number; end: number; name: string }> = [];
  found.forEach((boundary, index) => {
    const start = index === 0 ? 0 : boundary.line;
    const end = (found[index + 1]?.line ?? lines.length) - 1;
    segments.push({ start, end, name: boundary.name });
  });
  const chunks: Array<{ start: number; end: number; name: string }> = [];
  for (const segment of segments) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && segment.end - last.start + 1 <= MAX_UNIT_LINES) last.end = segment.end;
    else chunks.push({ ...segment });
  }
  const used = new Map<string, number>();
  return chunks.map((chunk) => {
    const seen = (used.get(chunk.name) ?? 0) + 1;
    used.set(chunk.name, seen);
    const name = seen === 1 ? chunk.name : `${chunk.name}~${seen}`;
    return { id: `${path}#${name}`, startLine: chunk.start + 1, endLine: chunk.end + 1 };
  });
}
