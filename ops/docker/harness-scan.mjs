#!/usr/bin/env node
// The release image's output scan (ARCHITECTURE §3.5, [SA-38]; spec 01 §4.9: only the `test`
// target holds packages/testing). app.Dockerfile's build-release stage and connector.Dockerfile's
// build stage run it right after the server bundle's release build, in the same RUN, over the
// directory the image's release stage copies to /app/dist/; any finding exits non-zero, which fails
// that RUN and so the image's build. app.Dockerfile's db-assets stage runs it as its last step over
// the database's files, the one other copy its release stage takes (release-allowlist.json), so
// every copy the release stage takes is scanned. The harness guard (packages/server/src/build/harness-guard.ts)
// refuses the harness while the bundle is built; this reads what the build actually left for the
// image, so a build that ran without the guard (a changed script or config) still cannot ship it
// with its markers in place.
//
// The rules are CI's bundle check's harness rules (.github/scripts/bundle-check.mjs, which the CI
// lane holds): in every file but a map, the `fin:test-seam` marker a seam module carries, a module
// comment naming a file of packages/testing (the harness bundled in), and an import of the
// harness's package left in (a static, side-effect or dynamic import, or a require call); in a
// source map, a `sources` entry under packages/testing (its sourcesContent, the original text with
// its comments, is not read). A module comment is the line the bundler writes before each module's
// code, the module's path alone: bundle-check reads `//#region <path>`, and this build's Vite
// writes `// <path>`, so both are read. A path through node_modules/@fin/testing, which the build
// writes only when it keeps symbolic links, counts as packages/testing. A map inlined as a base64
// `data:` URL is read as a map. A link in the output is refused, since the image would copy the
// link and not what it names. This file is self-contained and uses Node built-ins only, so it runs
// in the build stage from the build context with no install (bundle-check is not in this branch,
// and imports the CI lane's helpers). Usage, from the repository's root:
//   node ops/docker/harness-scan.mjs <output directory>
// It exits 0 when the directory holds at least one file and nothing the rules refuse, 1 on any
// finding, and 2 when the directory is missing, not a directory or empty.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** A file of the harness, by its repository path or by its package's link. */
const HARNESS_PATH = /(?:^|[/\\])(?:packages[/\\]testing|node_modules[/\\]@fin[/\\]testing)[/\\]/;

/** The markers read in each file of the output but its maps, with what each one means. */
export const MARKERS = [
  { pattern: /fin:test-seam/, what: "a test seam's marker (fin:test-seam)" },
  {
    pattern:
      /^\/\/(?:#region)?[ \t]+\S*(?:packages\/testing|node_modules\/@fin\/testing)\/\S*[ \t]*\r?$/m,
    what: "a module of the test harness (packages/testing) is bundled",
  },
  {
    pattern:
      /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@fin\/testing(?:\/[^"']*)?["']/,
    what: "the test harness's package (@fin/testing) is imported",
  },
];

// A source map inlined as a base64 `data:` URL in a `sourceMappingURL` comment.
const INLINE_MAP =
  /[#@]\s*sourceMappingURL=data:application\/json;(?:charset=[\w-]+;)?base64,([A-Za-z0-9+/]+={0,2})/g;

const MAX_FILES = 50_000;

/** @typedef {{ file: string, what: string }} Finding */

/**
 * The `sources` of the source map `text`, or null when it is not one.
 * @param {string} text
 * @returns {string[] | null}
 */
export function mapSources(text) {
  try {
    const map = JSON.parse(text);
    if (typeof map !== "object" || map === null || !Array.isArray(map.sources)) return null;
    return map.sources.filter((/** @type {unknown} */ source) => typeof source === "string");
  } catch {
    return null;
  }
}

/**
 * What the rules find in one file of the output, `name` its path in the output.
 * @param {string} name
 * @param {Buffer} bytes
 * @returns {string[]}
 */
export function scanFile(name, bytes) {
  /** @type {string[]} */
  const found = [];
  const readMap = (/** @type {string} */ text, /** @type {string} */ which) => {
    const sources = mapSources(text);
    if (sources === null) found.push(`${which} that is not a source map`);
    else if (sources.some((source) => HARNESS_PATH.test(source))) {
      found.push(`${which} names a file of the test harness (packages/testing) in its sources`);
    }
  };
  if (name.endsWith(".map")) {
    readMap(bytes.toString("utf8"), "a map");
    return found;
  }
  // Each byte as one character, so a marker is found whatever the file's encoding.
  const text = bytes.toString("latin1");
  for (const marker of MARKERS) {
    if (marker.pattern.test(text)) found.push(marker.what);
  }
  for (const match of text.matchAll(INLINE_MAP)) {
    readMap(Buffer.from(match[1] ?? "", "base64").toString("utf8"), "an inline map");
  }
  return found;
}

/**
 * Scans every file under `dir`: each finding names the file by its path in the output. A link is
 * a finding of its own and is never followed.
 * @param {string} dir
 * @returns {{ files: number, findings: Finding[] }}
 */
export function scanOutput(dir) {
  /** @type {Finding[]} */
  const findings = [];
  let files = 0;
  /** @param {string} at */
  const visit = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const file = relative(dir, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        findings.push({ file, what: "a link, which the image would copy as a link" });
      } else if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        files++;
        if (files > MAX_FILES) throw new Error(`more than ${MAX_FILES} files under ${dir}`);
        for (const what of scanFile(file, readFileSync(path))) findings.push({ file, what });
      } else {
        findings.push({ file, what: "neither a file nor a directory" });
      }
    }
  };
  visit(dir);
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files, findings };
}

/**
 * Runs the scan over the directory `args` names; returns the exit code and the lines to print.
 * @param {string[]} args
 * @returns {{ code: number, lines: string[] }}
 */
export function main(args) {
  const [dir, ...rest] = args;
  if (dir === undefined || rest.length > 0) {
    return { code: 2, lines: ["usage: node ops/docker/harness-scan.mjs <output directory>"] };
  }
  /** @type {import("node:fs").Stats} */
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return { code: 2, lines: [`harness-scan: ${dir} does not exist: the build left no output`] };
  }
  if (!stat.isDirectory()) {
    return { code: 2, lines: [`harness-scan: ${dir} is not a directory`] };
  }
  const { files, findings } = scanOutput(dir);
  if (findings.length > 0) {
    return {
      code: 1,
      lines: [
        ...findings.map((finding) => `harness-scan: ${dir}/${finding.file}: ${finding.what}`),
        "harness-scan: the release output holds the test harness, which only the test target " +
          `may contain (ARCHITECTURE §3.5, SA-38): ${findings.length} finding(s)`,
      ],
    };
  }
  if (files === 0) return { code: 2, lines: [`harness-scan: ${dir} holds no file`] };
  return { code: 0, lines: [`harness-scan: ${dir}: ${files} file(s), no harness marker`] };
}

if (import.meta.main) {
  const { code, lines } = main(process.argv.slice(2));
  const out = code === 0 ? process.stdout : process.stderr;
  out.write(`${lines.join("\n")}\n`);
  process.exitCode = code;
}
