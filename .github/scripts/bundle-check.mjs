#!/usr/bin/env node
// The build job's bundle checks, and the release's scan of each static artefact (spec 01 §5.3;
// ARCHITECTURE §3.4 FW-C12, §3.5, §11.2, §11.7; FW-C04, FW-C05). A control path.
//   server bundles (apps/<app>/dist/server/**), the release target CI builds by default
//     - no test seam in the JavaScript (ARCHITECTURE §3.5: CI greps the release bundles for the
//       seams' markers): the build-target define left unreplaced (`__FIN_BUILD_TARGET__`), the
//       `fin:test-seam` marker a seam module carries, a `//#region` of packages/testing (the
//       harness bundled in), or an import of @fin/testing left in;
//     - no packages/testing source in a map's `sources` (its sourcesContent, the original text
//       with its comments, is not read);
//   static builds (apps/<app>/dist/static/**), and with --artefacts <dir> each folder in <dir>
//   (release.yml: every staged static artefact, the previous release's carried assets included)
//     - FW-C12's scan: no secret shape and nothing public-safety refuses in any file, read with
//       scripts/public-safety.mjs's own rules (and the overlay's refuse list when FIN_OVERLAY_FILE
//       names one); and, in every file a browser reads as text (STATIC_TEXT_FILES) and every
//       other file that is not binary (an unknown extension, or none): no server setting's name
//       (`FIN_*`: a build takes public settings only, and env.json's fields are not named so; the
//       samples' shell variables the plan names, SAMPLE_NAMES, are no setting's); no
//       server-only marker (a `node:` module import, or Vite's stand-in for one,
//       `__vite-browser-external`); no test seam marker;
//     - in the same files, no third-party origin: every http, https, ws or wss URL and every
//       protocol-relative one where a URL starts (after a quote, an unquoted attribute's `=` in
//       markup or in a start tag a script writes, CSS's url(, a refresh's time, a template
//       literal's substitution, or as a srcset candidate; and after any C0 control or space, which
//       the URL parser strips first), and in a script every `://` in a string's text that no
//       scheme the text fixes stands before (`${s}://host`, `"{scheme}://host"`, `"%s://host"`),
//       and every host a script joins to a scheme from literals or chooses among them
//       (`"https://"+"host"`, `` `https://${p?`a.host`:`b.host`}` ``), has an origin on
//       ALLOWED_ORIGINS, the namespace and message
//       URLs the pinned libraries carry, none of which is fetched; and no URL with a user name or
//       password, whose host is not the one it seems to name. Each URL is read as a browser reads
//       it, in every reading of the text a browser may apply (readings: JavaScript's and JSON's
//       escapes, a classic script's octal ones included, CSS's, HTML's character references, and
//       one after another where a browser applies them in turn, as to CSS or a style attribute a
//       script holds; a character a reference or a CSS escape spells is data to the markup's or
//       the stylesheet's tokenizer, never a value's or a tag's end): its scheme in any case, a
//       backslash as a slash, any run of slashes, no slashes at all where a literal starts
//       (`"wss:host"`), tabs and new lines dropped, and its authority everything up to the first
//       /, \, ? or # or where the browser ends its literal (a quote; ASCII white space or `>`
//       after an unquoted attribute; ASCII white space or `)` in an unquoted url(; ASCII white
//       space in a srcset; the end of a refresh's value), less the C0 controls and spaces the URL
//       parser strips at its end, the host after its last `@`. White space after the slashes is
//       the URL's own. A quote inside the literal may end the script's own string or a value the
//       quote's other spelling opened, so the URL is read both up to it and past it; so is a
//       script's `${`, which may be a template literal's substitution. A URL whose authority (or
//       a srcset that does not close, or a srcset template literal that closes past the bound)
//       runs past what the scanner reads, or, after a scheme the text fixes, whose host it reads
//       but a URL parser refuses, is refused, never read as its first part names or passed as a
//       host built at run time. With no scheme in the text, such a host loads nothing and is no
//       finding, and backslashes alone or a scheme written at run time name a host only where it
//       has a dot or is an IP address (a pattern's `\\n` names none). Where only a guess says a
//       URL starts (after a `}` that may close a substitution, a refresh whose time a script
//       writes, `://` after a scheme written at run time), two slashes count only as the source
//       text wrote them: a regular expression's escaped `/\/` is code. A host a script builds at
//       run time from a name or a call (`"https://" + host`, `https://${host}`) is not read
//       here: the page's own policy refuses it in the browser. The work is linear in the text,
//       counted, not timed (scanWork);
//     - no source map (`*.map` in any case, or a `sourceMappingURL` comment pointing at one);
//     - nothing a deployment refuses (release-static.mjs's artefactProblems: `_headers` or
//       `env.json`, which the deploy renders, SF-05; a Worker control file; a path the deploy
//       refuses or would read two ways; an asset over 25 MiB);
//   and no link anywhere. The built index.html's inline scripts, handlers and the rest of FW-C04
// are scripts/static-check.mjs's, which the build job runs next; gitleaks scans the same folders
// (gitleaks-static.sh). While no app has been built, the check passes with a notice.
//
// `process.env` is not refused: isomorphic libraries guard it with `typeof process`, and a server
// configuration module is caught by its settings' names instead.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
  decodeContent,
  loadRefuseList,
  refuseMatcher,
  scanContent,
} from "../../scripts/public-safety.mjs";
import { annotate, clean, isMain, say } from "./lib/ci.mjs";
import { artefactProblems, isSourceMap } from "./release-static.mjs";

/** @typedef {{ file: string, rule: string, message: string }} Finding */
/** @typedef {import("../../scripts/public-safety.mjs").RefuseMatcher} RefuseMatcher */

/** Seam markers in a bundle's JavaScript. */
export const SEAM_MARKERS = [
  { pattern: /\b__FIN_BUILD_TARGET__\b/, what: "the build target was not compiled in" },
  { pattern: /fin:test-seam/, what: "a test seam's marker" },
  {
    pattern: /^\/\/#region\s+\S*packages\/testing\//m,
    what: "the test harness (packages/testing) is bundled",
  },
  {
    pattern: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@fin\/testing(?:\/[^"']*)?["']/,
    what: "the test harness (@fin/testing) is imported",
  },
];

/** Markers of server-only code in a client build (FW-C12: no node:* in the client). */
export const SERVER_MARKERS = [
  {
    pattern:
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*|\bexport\s*\*\s*from\s*)["'`]node:[^\s"'`]+["'`]/,
    what: "a node: module is imported (FW-C12: client code imports no node:*)",
  },
  {
    pattern: /__vite-browser-external/,
    what: "Vite's stand-in for a Node module (client code imported one)",
  },
];

/** A server setting's name: Fin's settings are `FIN_*` (env.json's fields are not). */
const SETTING_NAME = /\bFIN_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g;
/**
 * The names the plan gives a customer's own shell variables in the docs' and the console's
 * samples (spec 05 §8.2 and §8.8: `$FIN_API_URL`, `$FIN_KEY`), which no server setting is ever
 * named, so a build may name them. Any other name is refused wherever it stands, after a `$`
 * included (a sample's `$FIN_API` is no name the plan gives one): a setting's longer name
 * (`FIN_KEY_SALT`) and a shorter one (`FIN_API`) alike.
 */
export const SAMPLE_NAMES = new Set(["FIN_API_URL", "FIN_KEY"]);

/**
 * Origins a static build may name, none of them fetched: XML namespaces; JSON Schema's dialect
 * identifiers (the `$schema` of the JSON Schema zod writes); React's error-decoder links in its
 * messages, TanStack Router's and SimpleWebAuthn's documentation links in their warnings, and
 * Tailwind's in the licence banner of the built stylesheet; and the placeholder origins TanStack
 * Router and Fin's own router parse relative URLs against (`.invalid` never resolves). Each new
 * one is a reviewed change here, made when a real build names it (the real-build test).
 */
export const ALLOWED_ORIGINS = new Set([
  "http://www.w3.org",
  "https://www.w3.org",
  "http://json-schema.org",
  "https://json-schema.org",
  "https://react.dev",
  "https://tanstack.com",
  "https://simplewebauthn.dev",
  "https://tailwindcss.com",
  "http://localhost",
  "https://fin.invalid",
]);

const SERVER_FILES = new Set([".js", ".mjs", ".cjs", ".map"]);
/**
 * Files a browser reads as text, scanned even when they hold a NUL byte. Every other file is
 * scanned unless it is binary (public-safety's decodeContent), so an image's own metadata is not
 * read as a page.
 */
const STATIC_TEXT_FILES = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
  ".txt",
  ".xml",
  ".xsl",
]);
/** Script and data files: their strings are read through JavaScript's escapes. */
const SCRIPT_FILES = new Set([".js", ".mjs", ".cjs", ".json", ".webmanifest"]);
const MAX_FILES = 50_000;

/**
 * The scanner's work, counted as the characters its passes and read-backs visit (a search the
 * runtime makes over the text counts as the characters it passes), so a test bounds it by a
 * multiple of the text's length with no clock (scanWork): load slows a run, never adds to its
 * count. `limit` stops a run that passes its bound at once (scanWork's), instead of letting a
 * read-back that has lost its linear bound run on for minutes.
 */
const work = { visits: 0, limit: Infinity };

/**
 * Counts work done.
 * @param {number} visits
 */
function spend(visits) {
  work.visits += visits;
  if (work.visits > work.limit) throw new Error(`the scan's work passed its bound, ${work.limit}`);
}

// ---- reading a URL as a browser does ---------------------------------------------------------

/**
 * What a reading puts where an escape or a character reference spelled a quote: such a quote is
 * part of the literal and does not end it.
 */
const QUOTE_MARKS = new Map([
  ['"', "\u{e000}"],
  ["'", "\u{e001}"],
  ["`", "\u{e002}"],
]);
const UNMARKED = new Map([...QUOTE_MARKS].map(([quote, mark]) => [mark, quote]));
const QUOTES = new Set(['"', "'", "`", "\u{e000}", "\u{e001}", "\u{e002}"]);
const JS_ESCAPES = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["f", "\f"],
  ["b", "\b"],
]);
/** The named character references that spell a URL's punctuation, white space or a quote. */
const NAMED_REFERENCES = new Map([
  ["sol", "/"],
  ["bsol", "\\"],
  ["colon", ":"],
  ["Tab", "\t"],
  ["NewLine", "\n"],
  ["period", "."],
  ["commat", "@"],
  ["quest", "?"],
  ["num", "#"],
  ["amp", "&"],
  ["AMP", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["QUOT", '"'],
  ["apos", "'"],
  ["grave", "`"],
  ["lpar", "("],
  ["rpar", ")"],
  ["equals", "="],
  ["comma", ","],
  ["semi", ";"],
  ["excl", "!"],
  ["dollar", "$"],
  ["percnt", "%"],
  ["plus", "+"],
  ["ast", "*"],
  ["lowbar", "_"],
  ["Hat", "^"],
  ["verbar", "|"],
  ["vert", "|"],
  ["lsqb", "["],
  ["lbrack", "["],
  ["rsqb", "]"],
  ["rbrack", "]"],
  ["lcub", "{"],
  ["lbrace", "{"],
  ["rcub", "}"],
  ["rbrace", "}"],
  ["nbsp", "\u{a0}"],
]);

/** @param {string} c */
const marked = (c) => QUOTE_MARKS.get(c) ?? c;
/**
 * A code point as HTML's character references and CSS's escapes read it: zero, or one past
 * Unicode's last, is U+FFFD.
 * @param {number} code
 */
const fromCode = (code) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\u{fffd}");
/**
 * A code point as JavaScript's escapes read it: zero is U+0000 (`\0`, `\x00`, `\u0000`), which
 * the URL parser strips where a URL starts.
 * @param {number} code
 */
const fromJsCode = (code) =>
  code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\u{fffd}";

/**
 * One reading of a text (readings): the text with one kind of escape read and, for HTML's
 * character references and CSS's escapes, which characters one spelled (`spelled[i] === 1`). A
 * spelled character is data to the tokenizer that reads the markup or the stylesheet: it never
 * ends a value, opens or ends a tag, a quote or a url( (`&gt;`, `&#32;`, `\9 `), while the URL
 * parser, which reads the value after them, reads it as itself. JavaScript's escapes are read
 * before the markup a script writes is tokenized, so they spell that markup's structure (`\x3e`
 * is a `>` there); only the quotes they spell are marked, as part of the script's own string.
 * Which characters they spelled is kept apart (`escaped[i] === 1`), for the one question that
 * needs the source text as written: whether two slashes are a URL's or a regular expression's
 * (`/\/\/cdn\.example\//` reads as `///cdn.example//`; a regular expression never starts with
 * two raw slashes).
 * @typedef {{ text: string, spelled: Uint8Array | null, escaped?: Uint8Array | null }} Reading
 */

/**
 * A text with the escapes a pattern finds read, and which characters they spelled. Over a reading
 * that is itself spelled (CSS's escapes in a style attribute, after HTML's references), a
 * character the earlier reading spelled stays spelled where it is copied unchanged, and one a
 * JavaScript escape spelled stays escaped (Reading's `escaped`).
 * @param {string | Reading} input
 * @param {RegExp} pattern a global pattern
 * @param {(m: RegExpExecArray) => string} decode an escape's text, or the match unchanged
 * @returns {Reading}
 */
function readEscapes(input, pattern, decode) {
  const {
    text,
    spelled: before,
    escaped: beforeEscaped = null,
  } = typeof input === "string" ? { text: input, spelled: null, escaped: null } : input;
  // An escape is two characters or more and spells two code units at most. A mark the earlier
  // reading has is copied; a new one is made once a character needs it.
  /** @type {Uint8Array | null} */
  let spelled = before === null ? null : new Uint8Array(text.length);
  const escaped = beforeEscaped === null ? null : new Uint8Array(text.length);
  let out = "";
  let last = 0;
  /** @param {number} from @param {number} to */
  const copy = (from, to) => {
    if (from < to) {
      if (before !== null) spelled?.set(before.subarray(from, to), out.length);
      if (beforeEscaped !== null) escaped?.set(beforeEscaped.subarray(from, to), out.length);
    }
    out += text.slice(from, to);
  };
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    copy(last, at);
    const c = decode(m);
    if (c === m[0]) {
      copy(at, at + c.length);
    } else {
      if (c !== "") {
        if (spelled === null) spelled = new Uint8Array(text.length);
        spelled.fill(1, out.length, out.length + c.length);
      }
      out += c;
    }
    last = at + m[0].length;
  }
  copy(last, text.length);
  spend(text.length);
  return {
    text: out,
    spelled: spelled === null ? null : spelled.subarray(0, out.length),
    escaped: escaped === null ? null : escaped.subarray(0, out.length),
  };
}

const JS_ESCAPE =
  /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\s\S]))/g;
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g;
const HTML_REFERENCE = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]{1,31}));?/g;

/**
 * A text with a JavaScript or JSON string's escapes read (`\/`, `\\`, `\x2f`, `\u{2f}` with any
 * number of leading zeros, `\t`, `\0` and a classic script's octal escapes such as `\1`, and the
 * rest; a line continuation is dropped).
 * @param {string} text
 */
export function decodeJsEscapes(text) {
  return readJsEscapes(text).text;
}

/**
 * A text with a JavaScript or JSON string's escapes read (decodeJsEscapes), and which characters
 * they spelled (`escaped`), found as the escapes are replaced: each escape's text starts where its
 * match did, less what the escapes before it took away.
 * @param {string} text
 * @returns {Reading}
 */
function readJsEscapes(text) {
  /** Where each escape's text starts and ends in the text read, in pairs. */
  /** @type {number[]} */
  const spans = [];
  let shift = 0;
  const out = text.replace(
    JS_ESCAPE,
    (
      /** @type {string} */ m,
      /** @type {string | undefined} */ braced,
      /** @type {string | undefined} */ u4,
      /** @type {string | undefined} */ x2,
      /** @type {string | undefined} */ octal,
      /** @type {string} */ other,
      /** @type {number} */ offset,
    ) => {
      const hex = braced ?? u4 ?? x2;
      let c = "";
      if (hex !== undefined) c = marked(fromJsCode(Number.parseInt(hex, 16)));
      else if (octal !== undefined) c = marked(fromJsCode(Number.parseInt(octal, 8)));
      else if (!/^(?:\r\n|[\n\r\u{2028}\u{2029}])$/u.test(other)) {
        c = marked(JS_ESCAPES.get(other) ?? other);
      }
      if (c !== "") spans.push(offset - shift, offset - shift + c.length);
      shift += m.length - c.length;
      return c;
    },
  );
  spend(text.length);
  if (spans.length === 0) return { text: out, spelled: null, escaped: null };
  const escaped = new Uint8Array(out.length);
  for (let k = 0; k < spans.length; k += 2) escaped.fill(1, spans[k] ?? 0, spans[k + 1] ?? 0);
  return { text: out, spelled: null, escaped };
}

/**
 * A text with CSS's escapes read (`\2f`, `\2f ` and `\/`; an escaped new line is dropped), and
 * which characters they spelled (with those an earlier reading spelled, over a Reading).
 * @param {string | Reading} text
 * @returns {Reading}
 */
function readCssEscapes(text) {
  return readEscapes(text, CSS_ESCAPE, ([, hex, newline, other]) => {
    if (hex !== undefined) return marked(fromCode(Number.parseInt(hex, 16)));
    if (newline !== undefined) return "";
    return marked(other ?? "");
  });
}

/**
 * A text with CSS's escapes read (`\2f`, `\2f ` and `\/`; an escaped new line is dropped).
 * @param {string} text
 */
export function decodeCssEscapes(text) {
  return readCssEscapes(text).text;
}

/**
 * A text with HTML's character references read, and which characters they spelled
 * (decodeHtmlReferences).
 * @param {string | Reading} text
 * @returns {Reading}
 */
function readHtmlReferences(text) {
  return readEscapes(text, HTML_REFERENCE, ([whole, decimal, hex, name]) => {
    if (decimal !== undefined) return marked(fromCode(Number.parseInt(decimal, 10)));
    if (hex !== undefined) return marked(fromCode(Number.parseInt(hex, 16)));
    const c = NAMED_REFERENCES.get(name ?? "");
    return c === undefined ? whole : marked(c);
  });
}

/**
 * A text with HTML's character references read: every numeric one (with any number of leading
 * zeros), and the named ones that spell a URL's punctuation (`&sol;`, `&colon;`, `&commat;`,
 * `&Tab;` and the rest).
 * @param {string} text
 */
export function decodeHtmlReferences(text) {
  return readHtmlReferences(text).text;
}

/**
 * Whether a reading's character at an index was spelled by a reference or a CSS escape.
 * @param {Reading} reading
 * @param {number} i
 */
const isSpelled = (reading, i) => reading.spelled !== null && reading.spelled[i] === 1;

/**
 * Whether a reading holds two slashes at an index as the source text wrote them: no reference,
 * CSS escape or JavaScript escape spelled either (a regular expression's `/\/` reads as `//`).
 * @param {Reading} reading
 * @param {number} i
 */
const rawSlashes = (reading, i) => {
  for (const k of [i, i + 1]) {
    if (reading.text[k] !== "/" || isSpelled(reading, k)) return false;
    if (reading.escaped != null && reading.escaped[k] === 1) return false;
  }
  return true;
};

/**
 * Every reading of a text a browser may apply to the strings in it: a script's or JSON's through
 * JavaScript's escapes, and after them HTML's references (markup a script writes), CSS's escapes
 * (CSS a script holds: `element.style`, `insertRule`, a stylesheet a string fills) and both in
 * turn (a style attribute in markup a script writes); a stylesheet's through CSS's escapes;
 * markup, and any other file, as written and through each of them, a style attribute's
 * references and then its CSS escapes included.
 * @param {string} text
 * @param {string} kind "script", "style" or "markup"
 * @returns {Reading[]}
 */
export function readings(text, kind) {
  /** @type {Reading[]} */
  const all = [];
  /** @param {Reading} r */
  const add = (r) => {
    const same = all.some(
      (o) =>
        o.text === r.text &&
        (o.spelled === null || r.spelled === null
          ? o.spelled === r.spelled
          : Buffer.from(o.spelled).equals(Buffer.from(r.spelled))),
    );
    if (!same) all.push(r);
  };
  if (kind === "script") {
    const js = readJsEscapes(text);
    const html = readHtmlReferences(js);
    add(js);
    add(html);
    add(readCssEscapes(js));
    add(readCssEscapes(html));
  } else if (kind === "style") {
    add(readCssEscapes(text));
  } else {
    const js = readJsEscapes(text);
    const html = readHtmlReferences(text);
    const jsHtml = readHtmlReferences(js);
    add({ text, spelled: null });
    add(html);
    add(js);
    add(jsHtml);
    add(readCssEscapes(text));
    add(readCssEscapes(html));
    add(readCssEscapes(js));
    add(readCssEscapes(jsHtml));
  }
  return all;
}

/** A browser drops every tab and new line in a URL, its scheme's included. */
const SEP = "[\\t\\n\\r]*";
/** A scheme whose URLs name a host (special schemes: a backslash is a slash, slashes optional). */
const SCHEME = new RegExp(
  `(?<![A-Za-z0-9+.\\-])(h${SEP}t${SEP}t${SEP}p(?:${SEP}s)?|w${SEP}s(?:${SEP}s)?)${SEP}:`,
  "gi",
);
/** A run of slashes or backslashes, as a browser skips before a special URL's host. */
const SLASH_RUN = /[\t\n\r]*(?:[/\\][\t\n\r]*)+/y;
/** Two slashes or backslashes: a protocol-relative URL where a URL starts. */
const TWO_SLASHES = /[/\\][\t\n\r]*[/\\]/g;
/** A srcset attribute's value, quoted or not (the separator, then the opening quote or none). */
const SRCSET = /srcset[ \t\n\r\f]*(=)[ \t\n\r\f]*(["'\u{e000}\u{e001}]?)/giu;
/**
 * In a script, also a srcset list a key opens: a property's (`srcSet:"`, `"srcset":"`,
 * `.srcset=` and a backtick, as the minifier prints it), setAttribute's (`"srcset","`), and a key
 * whose quotes an escape spells (JSON in a string: `"{\"srcset\":\"...\"}"`).
 */
const SCRIPT_SRCSET =
  /srcset[ \t\n\r\f]*(?:["'`\u{e000}-\u{e002}][ \t\n\r\f]*)?([=:,])[ \t\n\r\f]*(["'`\u{e000}-\u{e002}]?)/giu;
/** A srcset candidate's scheme, after what the URL parser strips first. */
const SRCSET_SCHEME = /(https?|wss?):/iy;
/**
 * The longest authority, and srcset value with no closing quote (or a template literal's that
 * closes past it), the scanner reads: a bound on its work only. A URL that runs past it is a
 * finding (url-unread), never read as what its first part names.
 */
export const MAX_AUTHORITY = 2048;
export const MAX_SRCSET = 4096;
/**
 * Whether the URL parser strips a character before or after a URL: every C0 control and the
 * space.
 * @param {string} c
 */
const stripped = (c) => c !== "" && c.charCodeAt(0) <= 0x20;
/** HTML's ASCII white space, which ends an unquoted attribute's value and a srcset candidate. */
const ASCII_SPACE = new Set(["\t", "\n", "\f", "\r", " "]);
/**
 * Whether CSS's unquoted url( holds a character only as a bad URL, which loads nothing: a quote
 * (or a quote an escape spelled), `(`, and a non-printable code point.
 * @param {string} c
 */
const cssBadUrl = (c) => {
  const code = c.charCodeAt(0);
  return (
    QUOTES.has(c) ||
    c === "(" ||
    code <= 0x8 ||
    code === 0xb ||
    (code >= 0xe && code <= 0x1f) ||
    code === 0x7f
  );
};
/**
 * Where a URL is, which decides where its text ends (`guessed`: a refresh's or a substitution's
 * context contextsBefore adds, in which a host no URL parser takes is no finding; `raw`: two
 * slashes start a URL there only as the source text wrote them, never as a regular expression's
 * escapes spell them; `network`: a host there counts only where a browser reaches it on the
 * network, networkHost).
 * @typedef {({ kind: "quoted", end: string, spelled: boolean }
 *   | { kind: "srcset", end: number }
 *   | { kind: "attribute" | "css" | "none" })
 *   & { guessed?: boolean, raw?: boolean, network?: boolean }} UrlContext
 */

/**
 * Where a start tag that can hold an attribute opens: `<`, a name a fetching element has
 * (letters, digits and hyphens), then white space or `/`, or a raw quote, which may end the
 * script's string with the tag going on in the next (`"<img"+" src=..."`), or a template
 * literal's substitution, which may write the white space and more (`` `<a${c} href=...>` ``) or
 * the name itself (`` `<${t} href=...>` ``); or `<` alone right before a raw quote, where the
 * code the string is joined to writes the name (`` `<`+t+` href=...>` ``, which the minifier
 * prints from `"<" + tag + ...`). A `<` before a substitution is as often a message's
 * (`` `${a}<${b}` ``, `` `<${name}> must be used inside` ``), so a tag a substitution ends or names
 * opens only where its literal goes on as markup (markupAfter), and is read by the template
 * literal's piece reading (attributeEquals): the code after the literal is no tag's.
 */
const TAG_OPEN =
  /<(?:[A-Za-z][A-Za-z0-9-]*[\t\n\f\r /"'`]|(?:[A-Za-z][A-Za-z0-9-]*)?(?=\$\{)|(?=["'`]))/g;
/** What ends a name in TAG_OPEN's first form; the form a substitution follows ends in none. */
const NAME_END = /[\t\n\f\r /"'`]$/;
/** How far after a substitution that ends a tag's name markupAfter looks: a bound on its work. */
const MAX_NAME_GAP = 256;

/**
 * Whether the text after a substitution that ends a start tag's name, or writes it, goes on as
 * that tag's markup: past a `}` that may close the substitution, before any raw `>`, `"` or `'`
 * and within MAX_NAME_GAP, an attribute's `=` (`` `<a${c} href=...>` ``), the literal's end, where
 * the tag may go on in the next string (`` `<a${c}`+` href=...>` ``), or another substitution,
 * which may write the attributes (`` `<a${c}${h?` href=...`:``}>` ``). A message goes on otherwise
 * (`` `<${o}> must be used inside` ``), and so does a plain string's `"<${"` (its quote comes
 * first).
 * @param {Reading} reading
 * @param {number[]} closes each `}` that may close the substitution
 */
function markupAfter(reading, closes) {
  const { text } = reading;
  let visited = 0;
  let markup = false;
  for (const close of closes) {
    const end = Math.min(text.length, close + 1 + MAX_NAME_GAP);
    let k = close + 1;
    for (; k < end && !markup; k++) {
      if (isSpelled(reading, k)) continue;
      const c = text[k];
      if (c === "=" || c === "`" || (c === "$" && text[k + 1] === "{")) markup = true;
      else if (c === ">" || c === '"' || c === "'") break;
    }
    visited += k - close;
    if (markup) break;
  }
  spend(visited);
  return markup;
}

/**
 * Whether a `<` right before a raw quote ends a string the code joins a tag's name to: past white
 * space after the quote, a `+` (`` `<`+t+` href=...>` ``).
 * @param {Reading} reading
 * @param {number} quote
 */
function nameJoined(reading, quote) {
  const { text } = reading;
  if (isSpelled(reading, quote)) return false;
  let k = quote + 1;
  while (ASCII_SPACE.has(text[k] ?? "")) k++;
  return text[k] === "+" && text[k + 1] !== "+";
}
// The HTML tokenizer's states inside a start tag, as bits, so every tag open at once is followed
// in one pass: before an attribute's name, in it, after it, before its value, in a double- or
// single-quoted value, in an unquoted one, after a quoted one.
const BEFORE_NAME = 1;
const NAME = 2;
const AFTER_NAME = 4;
const BEFORE_VALUE = 8;
const DOUBLE = 16;
const SINGLE = 32;
const UNQUOTED = 64;
const AFTER_QUOTED = 128;

/**
 * One tokenizer state's next states on a character, as bits (0 when the tag ends at `>`). A quote
 * an escape spelled is a quote: the browser reads the string the script writes. A raw quote that
 * opens a value may instead end the script's own string, the value being built at run time and
 * the tag going on in the next string (`'<img alt='+x+" src=..."`), so it opens both a quoted
 * value and an unquoted one. A character a reference spelled is data (`data`): the tokenizer
 * reads the reference as text.
 * @param {number} state
 * @param {string} c
 * @param {boolean} data
 */
function nextTagState(state, c, data) {
  const space = !data && (c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ");
  const double = !data && (c === '"' || c === "\u{e000}");
  const single = !data && (c === "'" || c === "\u{e001}");
  if (state === DOUBLE) return double ? AFTER_QUOTED : DOUBLE;
  if (state === SINGLE) return single ? AFTER_QUOTED : SINGLE;
  if (!data && c === ">") return 0;
  if (state === UNQUOTED) return space ? BEFORE_NAME : UNQUOTED;
  if (state === BEFORE_VALUE) {
    if (space) return BEFORE_VALUE;
    const raw = c === '"' || c === "'" ? UNQUOTED : 0;
    return double ? DOUBLE | raw : single ? SINGLE | raw : UNQUOTED;
  }
  const slash = !data && c === "/";
  if (state === BEFORE_NAME) return space || slash ? BEFORE_NAME : NAME;
  if (state === AFTER_QUOTED) return space || slash ? BEFORE_NAME : NAME;
  // NAME and AFTER_NAME
  if (!data && c === "=") return BEFORE_VALUE;
  if (slash) return BEFORE_NAME;
  if (space) return AFTER_NAME;
  return NAME;
}

/**
 * How far after a `${` the scanner looks for the `}` that closes it: a bound on a lexer run's
 * work (lexSubstitution), and, where no `}` is known (an empty list in substitutions), how far
 * any raw `}` is taken to be the one, past which only the literal reading goes on.
 */
const MAX_SUBSTITUTION = 4096;

/**
 * Where each raw `${` of a reading starts (a template literal's substitution, which a script
 * fills in at run time, or text in a plain string), mapped to every `}` that may close it, or to
 * none when neither reading knows one. Braces counted as code's give one; where a quote, a
 * backtick or a `/` stands in it, or counting closes it nowhere, a brace in a string, a nested
 * template literal or a regular expression may pair with the wrong one (`${a?"{":""}`,
 * `${s.split("}")}`, `${a.replace(/{/g,"")}`), so lexSubstitution also reads it as JavaScript.
 * Both `}`s are kept, so neither reading is lost where the other is wrong. A brace a reference or
 * an escape spelled is text in a string, never code's. The `}`s that surely close one go in
 * `sure`: those counting pairs with no quote, backtick or `/` between, and those the lexer pairs.
 * @param {Reading} reading
 * @param {Set<number>} [sure]
 * @returns {Map<number, number[]>}
 */
function substitutions(reading, sure = new Set()) {
  const { text } = reading;
  /** @type {Map<number, number[]>} */
  const spans = new Map();
  /** @type {number[]} */
  const open = [];
  /** The starts whose counted `}` is no guide. */
  /** @type {number[]} */
  const unsure = [];
  let lastUnsure = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`" || c === "/") {
      lastUnsure = i;
    } else if (c === "{" && !isSpelled(reading, i)) {
      const raw = text[i - 1] === "$" && !isSpelled(reading, i - 1);
      open.push(raw ? i - 1 : -1);
      if (raw) spans.set(i - 1, []);
    } else if (c === "}" && !isSpelled(reading, i)) {
      const start = open.pop();
      if (start !== undefined && start >= 0) {
        spans.get(start)?.push(i);
        if (lastUnsure > start) unsure.push(start);
        else sure.add(i);
      }
    }
  }
  spend(text.length);
  for (const start of open) if (start >= 0) unsure.push(start);
  unsure.sort((a, b) => a - b);
  // Each run is bounded by MAX_SUBSTITUTION, and all of them by a budget linear in the text: past
  // it, a start keeps its counted `}`, or none (any raw `}` within the bound may close it).
  let budget = 2 * text.length + 64 * MAX_SUBSTITUTION;
  /** @type {Set<number>} */
  const done = new Set();
  for (const start of unsure) {
    if (budget <= 0) break;
    if (done.has(start)) continue;
    const run = lexSubstitution(reading, start, spans, done, sure);
    budget -= run;
    spend(run);
  }
  return spans;
}

/** In lexSubstitution's frames: a `{` in code, and a nested template literal's text. */
const BRACE = -1;
const TEMPLATE = -2;
/** What a regular expression may follow in code (a `/` after anything else divides). */
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORD =
  /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|else|do|yield|await)[\t\n\f\r ]*$/;

/**
 * Pairs a raw `${` with the `}` a JavaScript lexer pairs it with, reading the text after it as
 * code from a fresh start, up to MAX_SUBSTITUTION: strings and regular expressions skipped (each
 * ends at the next raw quote or `/`), nested template literals and their substitutions followed,
 * braces counted. A `${` in a plain string starts no substitution, but no lexer that starts
 * mid-file can tell, so its run reads out of step; since every run starts afresh, that costs
 * only its own pairing. A `${` a run meets in code is in the state its own run would start in, so
 * the `}` the run pairs it with is its own run's, and it is done; one still open where the run
 * stops gets its own run. Returns the run's work.
 * @param {Reading} reading
 * @param {number} start
 * @param {Map<number, number[]>} spans
 * @param {Set<number>} done the starts paired, or given up on, so far
 * @param {Set<number>} sure the `}`s that surely close a substitution, which the run adds to
 */
function lexSubstitution(reading, start, spans, done, sure) {
  const { text } = reading;
  const limit = Math.min(text.length, start + MAX_SUBSTITUTION);
  /** A substitution's start, BRACE or TEMPLATE, innermost last. */
  const frames = [start];
  // The character that ends the string or regular expression being skipped, or "".
  let skip = "";
  // The last character of code before a `/`, which tells a regular expression from a division.
  let prev = "{";
  let i = start + 2;
  for (; i < limit; i++) {
    if (isSpelled(reading, i)) continue;
    const c = text[i] ?? "";
    if (skip !== "") {
      if (c === skip) {
        skip = "";
        prev = ")";
      }
      continue;
    }
    if (c === "$" && text[i + 1] === "{" && !isSpelled(reading, i + 1)) {
      frames.push(i);
      prev = "{";
      i++;
      continue;
    }
    if (frames.at(-1) === TEMPLATE) {
      if (c === "`") {
        frames.pop();
        prev = ")";
      }
      continue;
    }
    if (c === '"' || c === "'") {
      skip = c;
    } else if (c === "`") {
      frames.push(TEMPLATE);
    } else if (c === "/") {
      const regex =
        REGEX_AFTER.has(prev) ||
        (prev === "a" && REGEX_KEYWORD.test(text.slice(Math.max(0, i - 24), i)));
      if (regex) skip = "/";
      else prev = "/";
    } else if (c === "{") {
      frames.push(BRACE);
      prev = c;
    } else if (c === "}") {
      const top = frames.pop() ?? start;
      if (top >= 0) {
        const ends = spans.get(top);
        if (ends !== undefined && !ends.includes(i)) ends.push(i);
        sure.add(i);
        done.add(top);
        if (top === start) return i - start;
      }
      prev = ")";
    } else if (!ASCII_SPACE.has(c)) {
      prev = /[\w$]/.test(c) ? "a" : c;
    }
  }
  done.add(start);
  return i - start;
}

/**
 * A start tag's states after a substitution, which may write any text: those before it (it may be
 * empty), a name's (it may write one), a new attribute's (it may end a value: `"`, `" `), and an
 * unquoted value's after `=` (it may write one).
 * @param {number} live
 */
function afterSubstitution(live) {
  if (live === 0) return 0;
  let after = live | NAME;
  if ((live & (DOUBLE | SINGLE | UNQUOTED)) !== 0) after |= AFTER_QUOTED | BEFORE_NAME;
  if ((live & BEFORE_VALUE) !== 0) after |= UNQUOTED;
  return after;
}

/**
 * A start tag's states after one character, every state in a set stepped at once.
 * @param {number} states
 * @param {string} c
 * @param {boolean} data
 */
function stepTag(states, c, data) {
  let after = 0;
  for (let bit = 1; bit <= AFTER_QUOTED; bit <<= 1) {
    if ((states & bit) !== 0) after |= nextTagState(bit, c, data);
  }
  return after;
}

/** The raw quotes a script's own strings start and end at. */
const SCRIPT_QUOTES = ['"', "'", "`"];
/**
 * What may stand before a string that goes on with markup a string before it began: a
 * concatenation (`+`, `+=`), a list's or a call's comma or bracket (`.join(...)`, `push(`), a
 * condition's branches (`?`, `:`, `&&`, `||`).
 */
const PIECE_AFTER = new Set([..."+,([?:&|"]);
/**
 * How far after the last raw quote the literal reading met with a start tag open (where the
 * script's string may have ended) a later string may go on with that tag: a bound on the readings
 * attributeEquals' piece readings add.
 */
const MAX_PIECE_GAP = 1024;

/**
 * Whether a raw quote at an index may open a string that goes on with markup an earlier string
 * began: the character before it, past ASCII white space, is one PIECE_AFTER holds, `+=`'s, or a
 * substitution's `${` (a template literal nested in one: `` `<a${c}${`href=...`}>` ``).
 * @param {string} text
 * @param {number} at
 */
function pieceStart(text, at) {
  let k = at - 1;
  while (ASCII_SPACE.has(text[k] ?? "")) k--;
  const c = text[k] ?? "";
  return (
    PIECE_AFTER.has(c) || (c === "=" && text[k - 1] === "+") || (c === "{" && text[k - 1] === "$")
  );
}

/**
 * A min-heap of indexes: adds one.
 * @param {number[]} heap
 * @param {number} value
 */
function heapPush(heap, value) {
  let k = heap.length;
  heap.push(value);
  while (k > 0) {
    const parent = (k - 1) >> 1;
    const above = heap[parent] ?? -Infinity;
    if (above <= value) break;
    heap[k] = above;
    k = parent;
  }
  heap[k] = value;
}

/**
 * A min-heap of indexes: drops the least.
 * @param {number[]} heap
 */
function heapPop(heap) {
  const last = heap.pop();
  if (last === undefined || heap.length === 0) return;
  let k = 0;
  for (;;) {
    let child = 2 * k + 1;
    if (child >= heap.length) break;
    if ((heap[child + 1] ?? Infinity) < (heap[child] ?? Infinity)) child++;
    const below = heap[child] ?? Infinity;
    if (below >= last) break;
    heap[k] = below;
    k = child;
  }
  heap[k] = last;
}

/**
 * The next index at or after `from` where a reading holds a character as written (not spelled
 * by a reference or an escape), or Infinity.
 * @param {Reading} reading
 * @param {string} c
 * @param {number} from
 */
function nextRaw(reading, c, from) {
  let k = reading.text.indexOf(c, from);
  while (k !== -1 && isSpelled(reading, k)) k = reading.text.indexOf(c, k + 1);
  return k === -1 ? Infinity : k;
}

/**
 * The `=` signs of a reading that give an attribute its value in some start tag, each tag read
 * as an HTML tokenizer reads it from its `<` (markup a script writes: `e.innerHTML='<img
 * src=//host/p.png>'`). A regular expression's `x=/\/a\//` is in none. Every tag open at a point
 * is followed at once (a tag inside another's quoted value included), so the pass is linear. A
 * character a reference spelled is data (`&gt;` ends no tag). Where the script's own code may
 * stand between pieces of the markup, the tag is read both through that code as text (the
 * literal reading) and past it, so neither reading drops an `=`:
 * - a template literal's `${...}`: after each `}` that may close it (substitutions), the states
 *   held at its `${` go on as well (afterSubstitution; `${a>b}` ends no tag). Where no `}` is
 *   known, every raw `}` up to MAX_SUBSTITUTION after it may be the one, so they go on after each;
 * - code between two strings: any raw quote with a tag open may end the script's string
 *   (`"<img "+(a>b?x:y)+" src=...>"`, `` let n=`<a `;n+=`href=...>` ``), so the states at it are
 *   held, up to MAX_PIECE_GAP after it, and go on at each later raw quote that may open the next
 *   string (pieceStart; any quote kind: `'<a class="'+c+'" '+(a>b?"x":"")+" href=...>"`). The
 *   code between may write any text, a value included (`` `<img width=`+(w>0?w:1)+` src=...>` ``),
 *   so each such string is read from the states afterSubstitution gives the held ones, up to its
 *   own closing quote, where its states are held too. The held states are kept for every string
 *   that may come next (a condition's branches each hold one, and one that ends in `+`, `:` or
 *   `,` looks like the next one's start), so a string after a tag may be read as part of it, but
 *   only within the bound, and only its own text: the code after a string is read by the
 *   literal reading only.
 * A tag a substitution ends or names (`` `<a${c} href=...>` ``, `` `<${t} href=...>` ``) opens
 * only where its literal goes on as markup (markupAfter), and is read by the template literal's
 * piece reading alone, never the literal one: `<` before a substitution is as often a comparison
 * in a message (`` `expected ${a}<${b}` ``), and the code after the literal is no tag's. Like
 * every piece, it holds its states at its closing backtick, so a later string (a concatenation,
 * a `+=`, a list's next item, a template literal nested in a substitution) goes on with the tag
 * (`` `<a${c}`+` href=...>` ``, `` `<a${c}${h?` href=...`:``}>` ``). So does a tag whose name the
 * code joins to a string that ends in `<` (`` `<`+t+` href=...>` ``): that string's quote holds it.
 * @param {Reading} reading
 * @param {() => Map<number, number[]>} spansOf the reading's substitutions
 * @returns {Set<number>}
 */
function attributeEquals(reading, spansOf) {
  const { text } = reading;
  /** @type {Set<number>} */
  const equals = new Set();
  // Where each tag's first state starts: after the white space, `/` or quote after its name, or
  // at the `${` that ends its name (or stands for it).
  /** @type {number[]} */
  const found = [];
  // The opens whose tag a substitution ends or names: read only by the template literal's piece
  // reading. And the `<`s whose string the code joins a name to, by index of their quote's kind.
  /** @type {Set<number>} */
  const written = new Set();
  /** @type {Map<number, number>} */
  const joined = new Map();
  for (const m of text.matchAll(TAG_OPEN)) {
    const at = m.index ?? 0;
    const last = at + m[0].length - 1;
    let raw = true;
    for (let k = at; k <= last && raw; k++) raw = !isSpelled(reading, k);
    if (!raw) continue;
    const quote = SCRIPT_QUOTES.indexOf(m[0] === "<" ? (text[at + 1] ?? "") : "");
    if (quote !== -1) {
      if (nameJoined(reading, at + 1)) joined.set(at, quote);
      continue;
    }
    found.push(last);
    if (!NAME_END.test(m[0])) written.add(last);
  }
  spend(text.length);
  for (const at of joined.keys()) found.push(at);
  found.sort((a, b) => a - b);
  if (found.length === 0) return equals;
  const spans = spansOf();
  // Such a tag opens only where its literal goes on as markup (markupAfter).
  const opens = found.filter(
    (last) => !written.has(last) || markupAfter(reading, spans.get(last + 1) ?? []),
  );
  if (opens.length === 0) return equals;
  // The states held at substitutions, by each `}` that may close them: the literal reading's,
  // and a template literal's piece reading's. `ends` orders those `}`s, least first.
  /** @type {Map<number, number>} */
  const pendingLive = new Map();
  /** @type {Map<number, number>} */
  const pendingPiece = new Map();
  /** @type {number[]} */
  const ends = [];
  /** The states at substitutions whose `}` is unknown, and how far a `}` may close one. */
  let unsureLive = 0;
  let unsureUntil = -1;
  // The states held where the script's string may end, and how far a later string may go on.
  let held = 0;
  let heldUntil = -1;
  /** @param {number} states @param {number} at */
  const hold = (states, at) => {
    held = (heldUntil < at ? 0 : held) | states;
    heldUntil = at + MAX_PIECE_GAP;
  };
  // The piece readings: a string that may go on with the tag, by SCRIPT_QUOTES' index, read from
  // the held states up to its closing quote.
  const piece = [0, 0, 0];
  const pieceOpen = [false, false, false];
  /** The next raw `}` and quotes, found once each and again only when passed. */
  const ahead = new Map();
  /** @param {string} c @param {number} from */
  const nextAt = (c, from) => {
    let at = ahead.get(c);
    if (at === undefined || at < from) {
      at = nextRaw(reading, c, from);
      ahead.set(c, at);
      spend(Math.min(at, text.length) - from);
    }
    return at;
  };
  let live = 0;
  let next = 0;
  let steps = 0;
  for (let i = 0; i < text.length; i++) {
    if (++steps === 65_536) {
      spend(steps);
      steps = 0;
    }
    if ((live | (piece[0] ?? 0) | (piece[1] ?? 0) | (piece[2] ?? 0)) === 0) {
      // Nothing is open: on to the next place a state may start.
      let target = Math.min(ends[0] ?? Infinity, opens[next] ?? Infinity);
      const brace = unsureUntil < i ? Infinity : nextAt("}", i);
      if (brace <= unsureUntil) target = Math.min(target, brace);
      const reviving = held !== 0 && heldUntil >= i;
      SCRIPT_QUOTES.forEach((q, k) => {
        if (reviving || pieceOpen[k]) target = Math.min(target, nextAt(q, i));
      });
      if (target === Infinity) break;
      i = Math.max(i, target);
    }
    const c = text[i] ?? "";
    const data = isSpelled(reading, i);
    // A substitution's states are held at its `${`; the literal reading steps through its text.
    const template = piece[2] ?? 0;
    if (c === "$" && (live | template) !== 0) {
      const closes = spans.get(i);
      if (closes !== undefined && closes.length === 0 && live !== 0) {
        if (unsureUntil < i) unsureLive = 0;
        unsureLive |= live;
        unsureUntil = i + MAX_SUBSTITUTION;
      }
      for (const end of closes ?? []) {
        if (live !== 0) pendingLive.set(end, (pendingLive.get(end) ?? 0) | live);
        if (template !== 0) pendingPiece.set(end, (pendingPiece.get(end) ?? 0) | template);
        heapPush(ends, end);
      }
    }
    const open = live | (piece[0] ?? 0) | (piece[1] ?? 0) | template;
    if (c === "=" && !data && (open & (NAME | AFTER_NAME)) !== 0) equals.add(i);
    const after = stepTag(live, c, data);
    const quote = data ? -1 : SCRIPT_QUOTES.indexOf(c);
    for (let k = 0; k < SCRIPT_QUOTES.length; k++) {
      if (!pieceOpen[k]) continue;
      const states = piece[k] ?? 0;
      if (k === quote) {
        // The piece's closing quote: its states go on in the next string, within MAX_PIECE_GAP
        // of this quote, as the literal reading's do.
        if (states !== 0) hold(states, i);
        piece[k] = 0;
        pieceOpen[k] = false;
      } else {
        piece[k] = stepTag(states, c, data);
      }
    }
    if (quote !== -1) {
      if (live !== 0) hold(live, i);
      if (held !== 0 && heldUntil >= i && pieceStart(text, i)) {
        // The code before the string may have written any text, as a substitution may.
        piece[quote] = (piece[quote] ?? 0) | afterSubstitution(held);
        pieceOpen[quote] = true;
      }
    }
    live = after;
    // At a `}` that may close a substitution, the held states go on beside the literal reading's,
    // never in place of them; a template literal's piece reading goes on in its text.
    if (ends[0] === i) {
      const fromLive = pendingLive.get(i);
      if (fromLive !== undefined) {
        live |= afterSubstitution(fromLive);
        pendingLive.delete(i);
      }
      const fromPiece = pendingPiece.get(i);
      if (fromPiece !== undefined) {
        piece[2] = (piece[2] ?? 0) | afterSubstitution(fromPiece);
        pieceOpen[2] = true;
        pendingPiece.delete(i);
      }
      while ((ends[0] ?? Infinity) <= i) heapPop(ends);
    }
    if (i <= unsureUntil && c === "}" && !data) live |= afterSubstitution(unsureLive);
    while (next < opens.length && (opens[next] ?? 0) <= i) {
      const kind = joined.get(i);
      if (opens[next] === i && written.has(i)) {
        // A tag a substitution ends or names: the template literal's piece reading.
        piece[2] = (piece[2] ?? 0) | BEFORE_NAME;
        pieceOpen[2] = true;
      } else if (opens[next] === i && kind !== undefined) {
        // A name the code joins to the string the `<` ends: that quote kind's piece reading,
        // whose closing quote, next, holds the tag for the next string.
        piece[kind] = (piece[kind] ?? 0) | BEFORE_NAME;
        pieceOpen[kind] = true;
      } else if (opens[next] === i) {
        live |= BEFORE_NAME;
        // A tag's name may end the script's string (`"<img"+" src=...>"`, `` [`<a`,...] ``).
        if (quote !== -1) hold(BEFORE_NAME, i);
      }
      next++;
    }
  }
  spend(steps);
  return equals;
}

/**
 * What stands before a URL, which decides where its text ends: a quote (or a quote an escape
 * spelled), the `=` of an unquoted attribute (anywhere in markup; in a start tag a script
 * writes, attributeEquals), CSS's `url(`, or nothing known. Whatever the URL parser strips first
 * (a C0 control or a space) is passed over. A `=` or `(` a reference or an escape spelled is
 * data, and starts nothing.
 * @param {Reading} reading
 * @param {number} index where the URL starts
 * @param {string} kind "script", "style" or "markup"
 * @param {(eq: number) => boolean} inTag whether the `=` at an index is an attribute's in a tag
 * @returns {UrlContext}
 */
function contextBefore(reading, index, kind, inTag) {
  const { text } = reading;
  let i = index - 1;
  while (i >= 0 && stripped(text[i] ?? "")) i--;
  spend(index - i);
  const c = text[i] ?? "";
  const spelled = isSpelled(reading, i);
  if (QUOTES.has(c)) return { kind: "quoted", end: c, spelled };
  if (spelled) return { kind: "none" };
  if (c === "=" && (kind === "markup" || (kind === "script" && inTag(i)))) {
    return { kind: "attribute" };
  }
  if (c === "(" && /url[ \t\n\r\f]*$/i.test(text.slice(Math.max(0, i - 16), i))) {
    return { kind: "css" };
  }
  return { kind: "none" };
}

/** A refresh's time: digits and dots. */
const TIME = /[0-9.]/;
/** A refresh's value starts at a quote, or at `=` in markup or in a start tag a script writes. */
const VALUE_START = new Set(["=", ...QUOTES]);

/**
 * What scanReading knows of a script's text, for the questions a time written at run time asks:
 * whether a `}` may close a substitution (`closes`: one counting or the lexer pairs with a `${`,
 * or any raw `}` near a `${` neither pairs), whether it surely does (`surely`: one the lexer pairs,
 * or counting where no quote, backtick or `/` stands between, so a plain string's `"${"` never
 * starts one), and whether a refresh key stands near an index (`refreshNear`).
 * @typedef {{ closes: (brace: number) => boolean, surely: (brace: number) => boolean,
 *   refreshNear: (at: number) => boolean }} ScriptFacts
 */

/**
 * Where a refresh's value starts, and how it is written (refreshStart): `named` when `url=`
 * stands before the URL, `written` when a script writes its time at run time.
 * @typedef {{ at: number, named: boolean, written: boolean }} RefreshStart
 */

/** How far before a refresh written at run time a refresh key (`refresh`) counts as its own. */
const REFRESH_REACH = 256;

/**
 * Where the value starts whose refresh URL (HTML's shared declarative refresh steps) starts at
 * an index, or null: the value's start, ASCII white space, a time of digits and dots (a digit in
 * it: prose's `'a'.` is no time), `;`, `,` or white space, white space, an optional `url=`, then
 * what the URL parser strips first (a C0 control or a space). In a script, a time written at run
 * time is read too (`written`), with `url=` or without it as a browser reads it
 * (`` `${n}; //host/x` ``): a substitution's `}` right before the separator
 * (`` `${n}; url=...` ``) or before the time's digits (`` `${n}0; //host/x` ``), whose literal
 * is a template literal (the `}` is returned), or
 * the quote that opens the string right before it (`n+"; url=..."`: the code before the string
 * wrote the time); and `url=` right after the quote that opens a string, the time and its
 * separator written apart (`[n,"url=//host/x"].join(";")`). Without `url=`, the `}` must surely
 * close a substitution (ScriptFacts' `surely`). A comment's `; // note` reads a host that starts
 * with white space, which no host does. Read back from the URL with no bound: each run it passes
 * holds no URL's start (a scheme's letter or a slash), so the runs read back from two URLs never
 * overlap and the work stays linear.
 * @param {Reading} reading
 * @param {number} index
 * @param {ScriptFacts | null} script what a script's text knows; null elsewhere
 * @returns {RefreshStart | null}
 */
function refreshStart(reading, index, script) {
  const { text } = reading;
  const space = (/** @type {number} */ k) => ASCII_SPACE.has(text[k] ?? "");
  const scriptQuote = (/** @type {number} */ k) =>
    SCRIPT_QUOTES.includes(text[k] ?? "") && !isSpelled(reading, k) && opensString(text, k);
  let i = index - 1;
  /**
   * The answer, with the work of reading back to it counted.
   * @param {RefreshStart | null} start
   */
  const done = (start) => {
    spend(index - Math.max(i, 0));
    return start;
  };
  while (i >= 0 && stripped(text[i] ?? "")) i--;
  const gap = i < index - 1;
  let sep = false;
  const named = text[i] === "=";
  if (named) {
    i--;
    while (i >= 0 && space(i)) i--;
    if (i < 2 || text.slice(i - 2, i + 1).toLowerCase() !== "url") return done(null);
    i -= 3;
    const before = i;
    while (i >= 0 && space(i)) i--;
    sep = i < before;
    if (script !== null && scriptQuote(i)) return done({ at: i, named, written: true });
  } else {
    sep = gap;
  }
  if (text[i] === ";" || text[i] === ",") {
    i--;
    while (i >= 0 && space(i)) i--;
    sep = true;
  }
  // A time ends at the separator: white space right after it, or `;` or `,`.
  if (!sep || !(space(i + 1) || text[i + 1] === ";" || text[i + 1] === ",")) return done(null);
  /** @param {number} k */
  const substitution = (k) =>
    text[k] === "}" && (named ? script?.closes(k) : script?.surely(k)) === true;
  if (script !== null && (substitution(i) || scriptQuote(i))) {
    return done({ at: i, named, written: true });
  }
  let digit = false;
  while (i >= 0 && TIME.test(text[i] ?? "")) {
    if (text[i] !== ".") digit = true;
    i--;
  }
  if (!digit) return done(null);
  if (script !== null && substitution(i)) return done({ at: i, named, written: true });
  while (i >= 0 && space(i)) i--;
  return done(VALUE_START.has(text[i] ?? "") ? { at: i, named, written: false } : null);
}

/**
 * Every context a URL may be in (contextBefore's, and each reading a browser may apply instead),
 * so its end is read in each and none is dropped. Beside the first: a later candidate of a srcset
 * list no key opens, after a descriptor (`c?"/a.png 1x, https://host/b.png 2x":x`;
 * descriptorBefore) or, in a script, in a list a string holds (`c?"/a.png, //host/b.png 2x":x`;
 * inList), which runs to ASCII white space; the text right after a template literal's
 * substitution (`${a} https://host/`, past what the URL parser strips), which runs to the
 * literal's backtick; and a refresh's URL (`content="0;https://host/"`), which runs to the end of
 * the value (to the template literal's backtick where a substitution wrote the time). The last
 * two are guessed: a host read in them that no URL parser takes is no finding (the first
 * context's reading still is). Where a script writes them (the text after a substitution, a
 * refresh whose time it writes), two slashes start a URL only as the source text wrote them
 * (`raw`): a regular expression's escaped `/\//` after a `}` or a string's end is code, never a
 * value. A refresh it writes with no `url=` names only a host a browser reaches on the network
 * (`network`), unless a refresh key stands near: a code generator's `";//eslint-disable-line"`
 * names no refresh's host.
 * @param {Reading} reading
 * @param {number} index where the URL starts
 * @param {string} kind "script", "style" or "markup"
 * @param {(eq: number) => boolean} inTag whether the `=` at an index is an attribute's in a tag
 * @param {(comma: number) => boolean} inList whether the comma at an index ends a candidate of a
 *   srcset list a script's string holds (srcsetListBefore)
 * @param {ScriptFacts | null} script what a script's text knows; null elsewhere
 * @returns {UrlContext[]}
 */
function contextsBefore(reading, index, kind, inTag, inList, script) {
  const { text } = reading;
  /** @type {UrlContext[]} */
  const all = [contextBefore(reading, index, kind, inTag)];
  let before = index - 1;
  while (before >= 0 && stripped(text[before] ?? "")) before--;
  spend(index - before);
  if (
    all[0]?.kind === "none" &&
    text[before] === "," &&
    (descriptorBefore(text, before) || (kind === "script" && inList(before)))
  ) {
    all.push({ kind: "srcset", end: text.length });
  }
  if (script !== null && text[before] === "}" && script.closes(before)) {
    all.push({ kind: "quoted", end: "`", spelled: false, guessed: true, raw: true });
  }
  const start = refreshStart(reading, index, script);
  if (start !== null) {
    const { at, named, written } = start;
    const c = text[at] ?? "";
    const spelled = isSpelled(reading, at);
    /** @type {{ guessed: true, raw?: boolean, network?: boolean }} */
    const how = written
      ? { guessed: true, raw: true, network: !named && script?.refreshNear(at) !== true }
      : { guessed: true };
    if (QUOTES.has(c)) {
      all.push({ kind: "quoted", end: c, spelled, ...how });
    } else if (c === "}" && !spelled) {
      // A time a substitution wrote: the value is a template literal's.
      all.push({ kind: "quoted", end: "`", spelled: false, ...how });
    } else if (!spelled && (kind === "markup" || (kind === "script" && inTag(at)))) {
      all.push({ kind: "attribute", ...how });
    }
  }
  return all;
}

/**
 * An authority as one reading reads it: `cut` when it ran past MAX_AUTHORITY; `crossed` when it
 * was read past where the literal may end, or in a guessed context; `built` when a script's
 * template literal substitution (a raw `${`) stands in it or right after it.
 * @typedef {{ authority: string, cut: boolean, crossed: boolean, built: boolean }} AuthorityRead
 */

/**
 * Where nothing known starts a URL, the scanner's end for it (white space, a quote, a bracket, a
 * comma or a semicolon) is a guess: a URL parser keeps all but the quote in a user name
 * (`see https://react.dev,@host/`). The authority read on from there to the next ASCII white
 * space, quote, `/`, `\`, `?` or `#`, when it reaches an `@` (`crossed`, as a reading past where
 * the literal may end), and also up to a `>` on the way, which may end an unquoted attribute's
 * value and its tag; none when no `@` is reached.
 * @param {Reading} reading
 * @param {number} from where the guessed end is
 * @param {number} start where the authority starts
 * @param {string} authority the authority up to the guessed end
 * @param {boolean} built as AuthorityRead's
 * @returns {AuthorityRead[]}
 */
function userNamePast(reading, from, start, authority, built) {
  const { text } = reading;
  /** @type {AuthorityRead[]} */
  const reads = [];
  /** @param {string} on */
  const keep = (on) => {
    if (on.includes("@", authority.length)) {
      reads.push({ authority: on, cut: false, crossed: true, built });
    }
  };
  let on = authority;
  let i = from;
  for (; i < text.length && i - start < MAX_AUTHORITY; i++) {
    const c = text[i] ?? "";
    if (c === "\t" || c === "\n" || c === "\r") {
      if (isSpelled(reading, i)) continue;
      break;
    }
    if (ASCII_SPACE.has(c) || "/\\?#".includes(c)) break;
    if (QUOTES.has(c) && !isSpelled(reading, i)) break;
    if (c === ">" && !isSpelled(reading, i)) keep(on);
    on += UNMARKED.get(c) ?? c;
  }
  spend(i - from + 1);
  keep(on);
  return reads;
}

/**
 * A URL's authority as a browser reads it: everything up to the first `/`, `\`, `?` or `#`, or the
 * end of its literal where the browser ends it, with tabs and new lines dropped where they are
 * the URL's own (in a quoted literal, or spelled by a reference or an escape). The literal ends
 * at its closing quote; at ASCII white space or `>` after an unquoted attribute; at ASCII white
 * space, `)` or what makes a bad URL in CSS's url(; at ASCII white space in a srcset candidate;
 * and, where nothing known starts the URL (it is not a literal's start), at white space (not a
 * byte order mark, which the host parser drops), quotes and brackets, and read on for a user name
 * (userNamePast). A character a reference or an escape spelled never ends a literal. A quote
 * inside a quoted literal, an unquoted attribute or a srcset may end the script's own string, or
 * close a value its other spelling opened: the authority is read both up to it and past it
 * (`crossed`). In a script, a raw `${` may be a template literal's substitution, which the script
 * fills in at run time: the authority is read both up to it, which names the host when one stands
 * before it, and past it (`built`). `cut` when it ran past MAX_AUTHORITY instead.
 * @param {Reading} reading
 * @param {number} start
 * @param {UrlContext} context
 * @param {boolean} script whether the text is a script's, whose `${` may be a substitution
 * @returns {AuthorityRead[]}
 */
function readAuthority(reading, start, context, script) {
  const { text } = reading;
  /** @type {AuthorityRead[]} */
  const reads = [];
  const stop = context.kind === "srcset" ? Math.min(context.end, text.length) : text.length;
  let authority = "";
  let crossed = context.guessed === true;
  let built = false;
  let i = start;
  for (; i < stop; i++) {
    if (i - start >= MAX_AUTHORITY) {
      spend(i - start);
      reads.push({ authority, cut: true, crossed, built });
      return reads;
    }
    const c = text[i] ?? "";
    const spelled = isSpelled(reading, i);
    // A srcset is split on its value's white space, a reference's included.
    if (context.kind === "srcset" && ASCII_SPACE.has(c)) break;
    if (c === "\t" || c === "\n" || c === "\r") {
      if (spelled || context.kind === "quoted") continue;
      break;
    }
    if ("/\\?#".includes(c)) break;
    if (context.kind === "quoted" && c === context.end && spelled === context.spelled) break;
    if (script && c === "$" && text[i + 1] === "{" && !spelled && !isSpelled(reading, i + 1)) {
      reads.push({ authority, cut: false, crossed, built: true });
      built = true;
      authority += "${";
      i++;
      continue;
    }
    if (context.kind === "none") {
      if ((/\s/.test(c) && c !== "\u{feff}") || QUOTES.has(c) || "<>()[]{},;".includes(c)) {
        reads.push(...userNamePast(reading, i, start, authority, built));
        break;
      }
    } else if (!spelled) {
      if (context.kind === "css") {
        if (c === " " || c === "\f" || c === ")" || cssBadUrl(c)) break;
      } else if (QUOTES.has(c)) {
        reads.push({ authority, cut: false, crossed, built });
        crossed = true;
      } else if (context.kind === "attribute" && (c === " " || c === "\f" || c === ">")) {
        break;
      }
    }
    authority += UNMARKED.get(c) ?? c;
  }
  spend(i - start + 1);
  reads.push({ authority, cut: false, crossed, built });
  return reads;
}

/**
 * @typedef {{ url: string, origin: string | null, userinfo: boolean, unread: boolean,
 *   unparsed: boolean }} FoundUrl
 */

/**
 * How a URL's start is written: a scheme the text fixes (`scheme`); slashes with no scheme, a
 * protocol-relative URL, at least one of them `/` (`slashes`) or backslashes only
 * (`backslashes`); or `://` after a scheme written at run time (`run-time`: `` `${s}://host` ``,
 * `s+"://host"`), read as https.
 * @typedef {"scheme" | "slashes" | "backslashes" | "run-time"} UrlStart
 */

/**
 * Whether a host the URL parser wrote names one a browser reaches on the network: it has a dot
 * (an IPv4 address in any spelling is written with dots) or is an IPv6 address. A single label
 * names no host anyone outside the network holds.
 * @param {string} hostname
 */
const networkHost = (hostname) => hostname.includes(".") || hostname.startsWith("[");

/**
 * A URL from its scheme and authority: its origin, or null when it has none the text fixes (a
 * host built at run time, or none a browser could load), whether it carries a user name or
 * password, whether its authority ran past what the scanner reads (`unread`), and whether the
 * scanner read a host no URL parser takes after a scheme the text fixes (`unparsed`), which is
 * refused rather than passed as one built at run time. With no scheme in the text, such a host
 * is no finding: the browser's parser is the same one, so the URL loads nothing, and two slashes
 * or backslashes start a pattern as often as a URL (a line comment's `//[^\n]*`, a string
 * escape's `\\(?:u...)`). Backslashes alone, and a scheme written at run time, name a host only
 * where it is one a browser reaches on the network (networkHost): a pattern's `\\n`, a bytea
 * escape's `\\x` and `${name}://inspect` name none; nor does a context that asks for one
 * (`network`: a refresh a script writes with no refresh key near, a code generator's
 * `";//eslint-disable-line"`). The URL parser drops the C0 controls and spaces at a URL's end as
 * it does those at its start, so they are dropped here too.
 * @param {string} scheme
 * @param {AuthorityRead} read
 * @param {UrlStart} start
 * @param {boolean} [network] whether the context counts only a host networkHost accepts
 * @returns {FoundUrl | null}
 */
function foundUrl(scheme, { authority, cut, crossed, built }, start, network = false) {
  let end = authority.length;
  while (end > 0 && stripped(authority[end - 1] ?? "")) end--;
  const read = authority.slice(0, end);
  if (read === "" && !cut) return null;
  const at = `${scheme}://${read}`;
  /** @type {URL | null} */
  let url = null;
  try {
    url = new URL(`${at}/`);
  } catch {
    // No host a URL parser takes.
  }
  if (url === null) {
    // Not refused: a host a script builds at run time (`https://${host}`: the page's own policy
    // refuses it in the browser), a reading past a quote that may end the literal or in a guessed
    // context (the reading up to it, or in the first context, is checked too), a host with no
    // letter or digit (a device path's `//./`), and one that starts with white space, which no
    // host does (a comment's `// note`; with a user name after it, the URL parses and is read).
    const unparsed =
      start === "scheme" &&
      !cut &&
      !crossed &&
      !built &&
      /[\p{L}\p{N}]/u.test(read) &&
      !/^\s/u.test(read);
    return { url: at, origin: null, userinfo: false, unread: cut, unparsed };
  }
  const needsNetwork = network || start === "backslashes" || start === "run-time";
  if (needsNetwork && !cut && !networkHost(url.hostname)) return null;
  // Read past a quote that ends the script's string, the host's last label holds the quote and the
  // code after it (`https://react.dev'+t+'`): a host built at run time. No top-level domain holds
  // a quote, so a host whose last label does is none a browser could load either way.
  if (crossed && /["'`]/.test(url.hostname.replace(/\.$/, "").split(".").at(-1) ?? "")) {
    return null;
  }
  // A host a script's substitution stands in is built at run time; the reading up to the
  // substitution names the fixed part before it, when there is one. A `$` anywhere else, or in
  // markup or a stylesheet, is the host's own.
  const runTime = !/[A-Za-z0-9]/.test(url.hostname) || (built && url.hostname.includes("${"));
  return {
    url: at,
    origin: runTime ? null : url.origin,
    userinfo: url.username !== "" || url.password !== "",
    unread: cut,
    unparsed: false,
  };
}

/**
 * Where each candidate of a srcset value starts, as a browser splits it: candidates are split on
 * ASCII white space and commas, a candidate's URL runs to white space (its trailing commas
 * dropped), and its descriptors run to the next comma.
 * @param {string} text
 * @param {number} from
 * @param {number} end
 * @returns {number[]}
 */
function srcsetStarts(text, from, end) {
  /** @type {number[]} */
  const starts = [];
  let i = from;
  while (i < end) {
    while (i < end && (ASCII_SPACE.has(text[i] ?? "") || text[i] === ",")) i++;
    if (i >= end) break;
    starts.push(i);
    while (i < end && !ASCII_SPACE.has(text[i] ?? "")) i++;
    if (text[i - 1] !== ",") while (i < end && text[i] !== ",") i++;
  }
  spend(end - from);
  return starts;
}

/** A template literal's substitution in a descriptor (`${dpr}x`), which stands for a number. */
const CANDIDATE_SUBSTITUTION = /\$\{[^{}\s"'`]*\}/g;
/** A srcset candidate's descriptor: a density, a width or a height. */
const DESCRIPTOR = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?[xwh]$/;

/**
 * Whether a comma ends a candidate of a srcset list no srcset key opens (a constant, a
 * condition's branch: `c?"/a.png 1x, //host/b.png 2x":x`), so a URL after it is a later
 * candidate: a descriptor (`2x`, `640w`, `1e1x`, `${dpr}x`) after ASCII white space stands right
 * before it, which code never writes. A list a key opens (SCRIPT_SRCSET) is read whole, whatever
 * its candidates hold; in a script, one a string holds is also read back to its quote
 * (srcsetListBefore). Each comma reads back one run, never past the comma before it, so the work
 * stays linear.
 * @param {string} text
 * @param {number} comma
 */
function descriptorBefore(text, comma) {
  let end = comma - 1;
  while (end >= 0 && ASCII_SPACE.has(text[end] ?? "")) end--;
  let start = end;
  while (start >= 0 && !ASCII_SPACE.has(text[start] ?? "") && !QUOTES.has(text[start] ?? "")) {
    if (text[start] === ",") break;
    start--;
  }
  spend(comma - start);
  if (text[start] === ",") return false;
  const run = text.slice(start + 1, end + 1).replace(CANDIDATE_SUBSTITUTION, "1");
  return start < end && ASCII_SPACE.has(text[start] ?? "") && DESCRIPTOR.test(run);
}

/** What a string may open after, past ASCII white space: an operator, a bracket or a separator. */
const STRING_AFTER = new Set([..."(,:=[{?&|+"]);

/**
 * Whether the quote at an index opens a string, judged by the code before it: the character
 * before it, past ASCII white space, is one STRING_AFTER holds, an arrow's `=>`, or the end of a
 * keyword an expression follows (`return"..."`), or the text starts there. A quote that closes a
 * string may stand after any of them (`"("+t`), so where it matters the text after the quote is
 * judged too (srcsetListBefore).
 * @param {string} text
 * @param {number} quote
 */
function opensString(text, quote) {
  let k = quote - 1;
  while (k >= 0 && ASCII_SPACE.has(text[k] ?? "")) k--;
  spend(quote - k);
  if (k < 0) return true;
  const c = text[k] ?? "";
  if (STRING_AFTER.has(c) || (c === ">" && text[k - 1] === "=")) return true;
  return /\w/.test(c) && REGEX_KEYWORD.test(text.slice(Math.max(0, k - 23), k + 1));
}

/**
 * A srcset candidate's URL in a list no key opens, with each substitution read as a word: a
 * path, a relative path or a word's start, and nothing code holds (a bracket, a brace, `<`, `>`,
 * `;`, a backslash, a quote, `^`, `|`, `*` or `$`). Code after a string's closing quote starts with
 * an operator or a bracket (`"x"),`, `"("+t,`, `"?".length,`), never so.
 */
const CANDIDATE_URL = /^(?:\.{0,2}\/|\w)[^()[\]{}<>;\\"'`^|*$\u{e000}-\u{e002}]*$/u;
/** A descriptor, misspelled ones included (`2X`, `100px`, `1.5dppx`): a number first. */
const DESCRIPTOR_LIKE = /^\.?[0-9][0-9A-Za-z.+-]*$/;

/**
 * Whether a comma ends a candidate of a srcset list a script's string holds where no srcset key
 * opens it (a condition's branch, a default, a constant, an object's value, a helper's argument:
 * `c?"/a.png, //host/b.png 2x":x`), so a URL after it is a later candidate. The list is read back
 * piece by piece (split at commas) from the comma to the quote that opens it: each piece is one
 * candidate, its URL (CANDIDATE_URL) and descriptors after white space, misspelled ones
 * included (DESCRIPTOR_LIKE); an empty piece (`,,`) is passed over. The quote must open a string
 * (opensString) and the first candidate stand right after it, past white space: a quote right
 * before a comma closes a string and opens no list. With no quote between the comma and the
 * quote, the whole list is that string's text when the quote opens it; the first candidate's
 * shape tells a closing quote from an opening one. Each comma passed is remembered with the
 * answer, so each piece is read back once and the work stays linear. A list whose first
 * candidate code builds (a helper's call or a condition in a substitution) is not read here: an
 * image list built at run time is the page policy's to refuse (img-src). A list a key opens is
 * read whole, whatever it holds.
 * @param {string} text
 * @param {number} comma
 * @param {Map<number, boolean>} known the answers so far, for this text
 */
function srcsetListBefore(text, comma, known) {
  /** @type {number[]} */
  const passed = [];
  let answer = false;
  for (let at = comma; ; ) {
    const before = known.get(at);
    if (before !== undefined) {
      answer = before;
      break;
    }
    passed.push(at);
    // The piece before the comma, read back run by run: its descriptors, then its URL.
    let i = at - 1;
    let url = "";
    let shape = true;
    for (;;) {
      while (i >= 0 && ASCII_SPACE.has(text[i] ?? "")) i--;
      const end = i;
      while (
        i >= 0 &&
        !ASCII_SPACE.has(text[i] ?? "") &&
        !QUOTES.has(text[i] ?? "") &&
        text[i] !== ","
      ) {
        i--;
      }
      if (i === end) break;
      // A run before another: the one after it is a descriptor.
      if (url !== "" && !DESCRIPTOR_LIKE.test(url.replace(CANDIDATE_SUBSTITUTION, "1"))) {
        shape = false;
        break;
      }
      url = text.slice(i + 1, end + 1);
    }
    spend(at - i);
    const start = text[i] ?? "";
    if (!shape) break;
    if (url === "") {
      if (start !== ",") break;
      at = i;
      continue;
    }
    if (!CANDIDATE_URL.test(url.replace(CANDIDATE_SUBSTITUTION, "x"))) break;
    if (start === ",") {
      at = i;
      continue;
    }
    answer = QUOTES.has(start) && opensString(text, i);
    break;
  }
  for (const at of passed) known.set(at, answer);
  return answer;
}

/**
 * The index of the first value at or after `at` in a list of indexes, least first, or Infinity.
 * @param {number[]} list
 * @param {number} at
 */
function firstFrom(list, at) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? Infinity) < at) lo = mid + 1;
    else hi = mid;
  }
  return list[lo] ?? Infinity;
}

/**
 * The last value before `at` in a list of indexes, least first, or -1.
 * @param {number[]} list
 * @param {number} at
 */
function lastBefore(list, at) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? Infinity) < at) lo = mid + 1;
    else hi = mid;
  }
  return list[lo - 1] ?? -1;
}

/** How many literals joined one after another a URL is read through (scanReading's joins). */
const MAX_JOINS = 4;

/**
 * Whether the text fixes a whole scheme before a colon in a string (from the string's start, or
 * after white space or punctuation): a letter, then letters, digits, `+`, `-` or `.`, as the URL
 * parser reads one (`git+https`, `chrome`, `mysql`). A scheme written at run time, in part or
 * whole, is none: after a substitution's `}` (`${p}s`), a placeholder's `%`, `{` or `$` (`%s`,
 * `$SCHEME`), or nothing at all (`{scheme}`, `"://"`).
 * @param {string} text
 * @param {number} colon
 * @param {number} opener where the string's text starts: its quote, or a substitution's `}`
 */
function fixedScheme(text, colon, opener) {
  let k = colon - 1;
  while (k > opener && /[A-Za-z0-9+.-]/.test(text[k] ?? "")) k--;
  spend(colon - k);
  return /^[A-Za-z]/.test(text.slice(k + 1, colon)) && !"}%{$".includes(text[k] ?? "");
}

/**
 * The literal string a raw quote at an index starts, before `limit`, as its text's start and its
 * closing quote, or null: a template literal with a substitution is no literal.
 * @param {Reading} reading
 * @param {number} at
 * @param {number} limit
 * @returns {[number, number] | null}
 */
function literalAt(reading, at, limit) {
  const { text } = reading;
  const quote = text[at] ?? "";
  if (!SCRIPT_QUOTES.includes(quote) || isSpelled(reading, at)) return null;
  for (let k = at + 1; k < limit; k++) {
    if (isSpelled(reading, k)) continue;
    const c = text[k];
    if (c === quote || (quote === "`" && c === "$" && text[k + 1] === "{")) {
      spend(k - at);
      return c === quote ? [at + 1, k] : null;
    }
  }
  spend(limit - at);
  return null;
}

/**
 * The bracket that closes the one at an index, before `limit`, past nested brackets and literals,
 * or -1.
 * @param {Reading} reading
 * @param {number} open
 * @param {number} limit
 */
function closingBracket(reading, open, limit) {
  const { text } = reading;
  let depth = 0;
  let k = open;
  let close = -1;
  for (; k < limit; k++) {
    if (isSpelled(reading, k)) continue;
    const c = text[k] ?? "";
    if (SCRIPT_QUOTES.includes(c)) {
      const literal = literalAt(reading, k, limit);
      if (literal === null) break;
      k = literal[1];
    } else if ("([{".includes(c)) {
      depth++;
    } else if (")]}".includes(c) && --depth === 0) {
      if (c === ")") close = k;
      break;
    }
  }
  spend(k - open);
  return close;
}

/**
 * The literals an expression from `from` to `to` (a substitution's, or brackets') chooses its
 * value from, each as its text's start and its closing quote, or null where it may take any other
 * value: a literal, alone, in brackets, as a condition's branch (`c?"a":"b"`, nested) or after
 * `||` or `??` (`"a"||"b"`). A condition may hold anything but a `:` or `,` of its own; a value
 * that is a name, a call or anything else is one built at run time.
 * @param {Reading} reading
 * @param {number} from
 * @param {number} to
 * @returns {[number, number][] | null}
 */
function literalChoice(reading, from, to) {
  const { text } = reading;
  /** @param {number} k */
  const space = (k) => {
    let j = k;
    while (j < to && ASCII_SPACE.has(text[j] ?? "")) j++;
    return j;
  };
  /**
   * The top-level `?` of a condition that starts at an index, or -1.
   * @param {number} p
   */
  const conditionEnd = (p) => {
    let depth = 0;
    let k = p;
    let mark = -1;
    for (; k < to; k++) {
      if (isSpelled(reading, k)) continue;
      const c = text[k] ?? "";
      if (SCRIPT_QUOTES.includes(c)) {
        const literal = literalAt(reading, k, to);
        if (literal === null) break;
        k = literal[1];
      } else if ("([{".includes(c)) {
        depth++;
      } else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && c === "?" && text[k + 1] === "?") {
        k++;
      } else if (depth === 0 && c === "?" && text[k + 1] !== ".") {
        mark = k;
        break;
      } else if (depth === 0 && (c === ":" || c === "," || c === ";")) {
        break;
      }
    }
    spend(k - p);
    return mark;
  };
  /**
   * @param {number} p
   * @param {number} depth
   * @returns {{ values: [number, number][], end: number } | null}
   */
  const value = (p, depth) => {
    if (depth > 8) return null;
    const at = space(p);
    const literal = literalAt(reading, at, to);
    /** @type {{ values: [number, number][], end: number } | null} */
    let r = null;
    if (literal !== null) {
      r = { values: [literal], end: literal[1] + 1 };
    } else if (text[at] === "(") {
      const inner = value(at + 1, depth + 1);
      const close = inner === null ? -1 : space(inner.end);
      if (inner === null || text[close] !== ")") return null;
      r = { values: inner.values, end: close + 1 };
    } else {
      const mark = conditionEnd(at);
      const yes = mark === -1 ? null : value(mark + 1, depth + 1);
      const colon = yes === null ? -1 : space(yes.end);
      if (yes === null || text[colon] !== ":") return null;
      const no = value(colon + 1, depth + 1);
      if (no === null) return null;
      r = { values: [...yes.values, ...no.values], end: no.end };
    }
    for (;;) {
      const op = space(r.end);
      if (!text.startsWith("||", op) && !text.startsWith("??", op)) return r;
      const more = value(op + 2, depth + 1);
      if (more === null) return null;
      r = { values: [...r.values, ...more.values], end: more.end };
    }
  };
  const r = value(from, 0);
  return r !== null && space(r.end) === to ? r.values : null;
}

/**
 * Where a template literal whose text starts at `from` closes, within MAX_SRCSET: the next raw
 * backtick past each substitution in it (the `}` the lexer pairs it with, where it ran, else the
 * counted one), or -1 when none closes it within the bound (a `}` or the backtick past it), so a
 * list is never read past the bound however far its substitutions' `}`s are, and the work stays
 * linear. A substitution whose `}` neither knows ends the search at the next raw backtick.
 * @param {number} from
 * @param {Map<number, number[]>} spans the reading's substitutions
 * @param {number[]} starts their starts, least first
 * @param {number[]} ticks the reading's raw backticks, least first
 */
function templateEnd(from, spans, starts, ticks) {
  for (let i = from; i - from <= MAX_SRCSET; ) {
    spend(1);
    const tick = firstFrom(ticks, i);
    const start = firstFrom(starts, i);
    const close = start < tick ? spans.get(start)?.at(-1) : undefined;
    if (close === undefined) return tick - from <= MAX_SRCSET ? tick : -1;
    i = close + 1;
  }
  return -1;
}

/**
 * The URLs one reading of a text names: every http, https, ws or wss URL (its scheme in any case,
 * with slashes or backslashes or, where a literal starts, none), every protocol-relative one
 * (two or more slashes or backslashes) where a URL starts, and every srcset candidate.
 * @param {Reading} reading
 * @param {string} kind "script", "style" or "markup": where `=` starts an unquoted attribute
 * @param {Map<string, FoundUrl>} found
 */
function scanReading(reading, kind, found) {
  const { text } = reading;
  /** @param {FoundUrl | null} u */
  const keep = (u) => {
    const key = JSON.stringify(u);
    if (u !== null && !found.has(key)) found.set(key, u);
  };
  /**
   * @param {string} scheme
   * @param {number} start
   * @param {UrlContext} context
   * @param {UrlStart} how
   */
  const read = (scheme, start, context, how) => {
    const reads = readAuthority(reading, start, context, kind === "script");
    if (how === "scheme" || how === "run-time") reads.push(...joinedReads(start, context, 0));
    for (const r of reads) {
      const authority = context.kind === "srcset" ? r.authority.replace(/,+$/, "") : r.authority;
      keep(foundUrl(scheme, { ...r, authority }, how, context.network === true));
    }
  };
  /** @type {Map<number, number[]> | null} */
  let spans = null;
  /** The `}`s that surely close a substitution (substitutions). */
  /** @type {Set<number>} */
  const sureEnds = new Set();
  const spansOf = () => {
    spans ??= substitutions(reading, sureEnds);
    return spans;
  };
  /**
   * The authorities a script joins to a URL's scheme from literals (`"https://"+"host/x"`,
   * `` `https://`+`host` ``), or chooses from literals in a substitution or brackets right after
   * it (`` `https://${p?`app.host`:`staging.host`}/x` ``, `` `https://`+(p?`a.host`:`b.host`) ``),
   * each literal as a host (with the text after the choice where the literal names only the
   * host's start), read as past the literal's end (`crossed`). A plain identifier, a call or
   * anything else between them is a host built at run time: the page's own policy refuses it.
   * Joins are followed up to MAX_JOINS deep, each over at most MAX_SUBSTITUTION characters.
   * @param {number} start where the authority starts
   * @param {UrlContext} context
   * @param {number} depth
   * @returns {AuthorityRead[]}
   */
  const joinedReads = (start, context, depth) => {
    /** @type {AuthorityRead[]} */
    const reads = [];
    if (kind !== "script" || depth >= MAX_JOINS) return reads;
    /**
     * @param {[number, number][]} values each literal's text, from its start to its closing quote
     * @param {() => string[]} after the authorities the text after the choice goes on with
     */
    const choose = (values, after) => {
      /** @type {string[] | null} */
      let goesOn = null;
      for (const [from, to] of values) {
        let value = "";
        for (let k = from; k < to; k++) {
          const c = text[k] ?? "";
          if (c !== "\t" && c !== "\n" && c !== "\r") value += UNMARKED.get(c) ?? c;
        }
        spend(to - from);
        const cut = value.search(/[/\\?#]/);
        if (cut === -1 && goesOn === null) goesOn = after();
        const rests = cut === -1 ? (goesOn ?? []) : [""];
        for (const rest of rests) {
          const authority = cut === -1 ? value + rest : value.slice(0, cut);
          reads.push({ authority, cut: false, crossed: true, built: false });
        }
      }
    };
    const space = (/** @type {number} */ k) => {
      let j = k;
      while (ASCII_SPACE.has(text[j] ?? "")) j++;
      return j;
    };
    /** @param {number} k */
    const rawQuote = (k) => SCRIPT_QUOTES.includes(text[k] ?? "") && !isSpelled(reading, k);
    if (text[start] === "$" && text[start + 1] === "{" && !isSpelled(reading, start + 1)) {
      const close = spansOf().get(start)?.at(-1);
      if (close === undefined || close - start > MAX_SUBSTITUTION) return reads;
      const values = literalChoice(reading, start + 2, close);
      if (values !== null) {
        choose(values, () =>
          readAuthority(reading, close + 1, context, true).map((r) => r.authority),
        );
      }
      return reads;
    }
    if (context.kind !== "quoted" || text[start] !== context.end) return reads;
    if (isSpelled(reading, start) !== context.spelled) return reads;
    let k = space(start + 1);
    if (text[k] !== "+" || text[k + 1] === "+") return reads;
    k = space(k + 1);
    if (rawQuote(k)) {
      // The next literal goes on with the URL: its slashes, then its authority.
      SLASH_RUN.lastIndex = k + 1;
      const from = k + 1 + (SLASH_RUN.exec(text)?.[0].length ?? 0);
      /** @type {UrlContext} */
      const next = { kind: "quoted", end: text[k] ?? "", spelled: false };
      for (const r of readAuthority(reading, from, next, true)) reads.push({ ...r, crossed: true });
      reads.push(...joinedReads(from, next, depth + 1));
    } else if (text[k] === "(") {
      const close = closingBracket(reading, k, Math.min(text.length, k + MAX_SUBSTITUTION));
      const values = close === -1 ? null : literalChoice(reading, k + 1, close);
      if (values !== null) {
        choose(values, () => {
          let j = space(close + 1);
          if (text[j] !== "+") return [""];
          j = space(j + 1);
          if (!rawQuote(j)) return [""];
          /** @type {UrlContext} */
          const next = { kind: "quoted", end: text[j] ?? "", spelled: false };
          return readAuthority(reading, j + 1, next, true).map((r) => r.authority);
        });
      }
    }
    return reads;
  };
  /** @type {Set<number> | null} */
  let equals = null;
  /** @param {number} eq */
  const inTag = (eq) => {
    equals ??= attributeEquals(reading, spansOf);
    return equals.has(eq);
  };
  /** @type {Set<number> | null} */
  let substitutionEnds = null;
  /** The starts whose `}` neither counting nor the lexer knows, least first. */
  /** @type {number[]} */
  const unknownStarts = [];
  /**
   * Whether the `}` at an index may close a substitution: one that counting or the lexer pairs
   * with a `${`, or any raw `}` up to MAX_SUBSTITUTION after a `${` neither pairs.
   * @param {number} brace
   */
  const closesSubstitution = (brace) => {
    if (substitutionEnds === null) {
      substitutionEnds = new Set();
      for (const [start, ends] of spansOf()) {
        if (ends.length === 0) unknownStarts.push(start);
        for (const end of ends) substitutionEnds.add(end);
      }
    }
    if (isSpelled(reading, brace)) return false;
    if (substitutionEnds.has(brace)) return true;
    let lo = 0;
    let hi = unknownStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((unknownStarts[mid] ?? Infinity) < brace) lo = mid + 1;
      else hi = mid;
    }
    const start = unknownStarts[lo - 1];
    return start !== undefined && brace - start <= MAX_SUBSTITUTION;
  };
  /** Where a refresh key stands, least first (ScriptFacts' `refreshNear`). */
  /** @type {number[] | null} */
  let refreshKeys = null;
  /** @type {ScriptFacts | null} */
  const script =
    kind === "script"
      ? {
          closes: closesSubstitution,
          surely: (brace) => {
            spansOf();
            return !isSpelled(reading, brace) && sureEnds.has(brace);
          },
          refreshNear: (at) => {
            if (refreshKeys === null) {
              refreshKeys = [...text.matchAll(/refresh/gi)].map((m) => m.index ?? 0);
              spend(text.length);
            }
            const key = lastBefore(refreshKeys, at);
            return key !== -1 && at - key <= REFRESH_REACH;
          },
        }
      : null;
  /** @type {Map<number, boolean>} */
  const listEnds = new Map();
  /** @param {number} comma */
  const inList = (comma) => srcsetListBefore(text, comma, listEnds);
  /** @param {number} start */
  const contexts = (start) => contextsBefore(reading, start, kind, inTag, inList, script);
  /** The raw quotes, and the `}`s counting or the lexer pairs with a `${`, least first. */
  /** @type {number[] | null} */
  let rawQuotes = null;
  /** @type {number[] | null} */
  let pairedEnds = null;
  /**
   * The string a script's colon is in, judged by the nearest raw quote or paired `}` before it:
   * the quote's index where it opens a string (opensString), the `}`'s where it closes a
   * substitution (template literal text), or -1 where the colon is code's (`"key":`, `c?"a":`).
   * @param {number} colon
   */
  const stringOf = (colon) => {
    if (rawQuotes === null) {
      rawQuotes = [];
      for (let k = 0; k < text.length; k++) {
        const c = text[k];
        if ((c === '"' || c === "'" || c === "`") && !isSpelled(reading, k)) rawQuotes.push(k);
      }
      spend(text.length);
    }
    pairedEnds ??= [...new Set([...spansOf().values()].flat())].sort((a, b) => a - b);
    const quote = lastBefore(rawQuotes, colon);
    const brace = lastBefore(pairedEnds, colon);
    if (brace > quote) return brace;
    return quote !== -1 && opensString(text, quote) ? quote : -1;
  };
  // The colons SCHEME reads: the slashes after one are its scheme's. Each pattern's search below
  // is one pass over the text.
  spend(3 * text.length);
  /** @type {Set<number>} */
  const schemeColons = new Set();
  for (const m of text.matchAll(SCHEME)) {
    const scheme = (m[1] ?? "").replace(/[\t\n\r]/g, "").toLowerCase();
    const after = (m.index ?? 0) + m[0].length;
    schemeColons.add(after - 1);
    SLASH_RUN.lastIndex = after;
    const run = SLASH_RUN.exec(text)?.[0] ?? "";
    for (const context of contexts(m.index ?? 0)) {
      // With no slash, only where a literal or a value starts (`"wss:host"`): `{https:443}` names
      // no URL, nor does a scheme after a comma (`{http:80,https:443}`).
      if (run === "" && (context.kind === "none" || context.kind === "srcset")) continue;
      read(scheme, after + run.length, context, "scheme");
    }
  }
  for (const m of text.matchAll(TWO_SLASHES)) {
    const start = m.index ?? 0;
    const before = text[start - 1] ?? "";
    if (before === "/" || before === "\\") continue; // inside a run
    SLASH_RUN.lastIndex = start;
    const run = SLASH_RUN.exec(text)?.[0] ?? "";
    // White space after the slashes is the URL's own: its host's, or a user name's before an `@`.
    const host = start + run.length;
    if (before === ":") {
      // A scheme's slashes; or, in a script, `://` in a string's or a template literal's text
      // after a scheme written at run time or not at all (`` `${s}://host` ``, `s+"://host"`,
      // `` `http${s?"s":""}://host` ``, `` `${p}s://host` ``, `"{scheme}://host"`, `"%s://host"`),
      // whose host is read as https. Only two raw slashes: a regular expression never starts with
      // them (`"key":/\/\/cdn\.example\//`), and only in a string, whose quote opens it; and not
      // after a scheme the text fixes, whose URL is that scheme's and loads no web page
      // (`git+https://`, `chrome://`, `socks5://`, `mysql://`).
      if (kind !== "script" || schemeColons.has(start - 1) || !rawSlashes(reading, start)) continue;
      const at = stringOf(start - 1);
      if (at === -1 || fixedScheme(text, start - 1, at)) continue;
      /** @type {UrlContext} */
      const context =
        text[at] === "}"
          ? { kind: "quoted", end: "`", spelled: false, guessed: true }
          : { kind: "quoted", end: text[at] ?? "", spelled: false };
      read("https", host, context, "run-time");
      continue;
    }
    const how = run.includes("/") ? "slashes" : "backslashes";
    for (const context of contexts(start)) {
      if (context.kind === "none") continue;
      if (context.raw === true && !rawSlashes(reading, start)) continue;
      read("https", host, context, how);
    }
  }
  /** @type {number[] | null} */
  let substitutionStarts = null;
  /** @type {number[] | null} */
  let ticks = null;
  for (const m of text.matchAll(kind === "script" ? SCRIPT_SRCSET : SRCSET)) {
    const separator = m[1] ?? "";
    const open = m[2] ?? "";
    const from = (m.index ?? 0) + m[0].length;
    let close = -1;
    if (open === "") {
      // An unquoted value, in markup or in a start tag a script writes: it ends at white space or
      // `>` as written, not at one a reference spells.
      if (separator !== "=" || kind === "style") continue;
      if (kind === "script" && !inTag((m.index ?? 0) + m[0].lastIndexOf("="))) continue;
      close = from;
      while (close < text.length && close - from <= MAX_SRCSET) {
        const c = text[close] ?? "";
        if ((ASCII_SPACE.has(c) || c === ">") && !isSpelled(reading, close)) break;
        close++;
      }
      spend(close - from);
      if (close - from > MAX_SRCSET) close = -1;
    } else if (open === "`" && !isSpelled(reading, from - 1)) {
      // A template literal: it closes past each substitution in it (`${asset(`a.png`)}`), within
      // the bound.
      substitutionStarts ??= [...spansOf().keys()];
      if (ticks === null) {
        ticks = [];
        for (let k = nextRaw(reading, "`", 0); k !== Infinity; k = nextRaw(reading, "`", k + 1)) {
          ticks.push(k);
        }
        spend(text.length);
      }
      close = templateEnd(from, spansOf(), substitutionStarts, ticks);
    } else {
      const spelled = isSpelled(reading, from - 1);
      close = text.indexOf(open, from);
      while (close !== -1 && isSpelled(reading, close) !== spelled) {
        close = text.indexOf(open, close + 1);
      }
      spend((close === -1 ? text.length : close) - from);
    }
    const end = close === -1 ? Math.min(text.length, from + MAX_SRCSET) : close;
    if (end < text.length && close === -1) {
      // Refused whole (url-unread), so its candidates are not read: each list read is one that
      // closes within the bound, and lists that run on past it cost no more than finding so.
      keep({ url: `srcset@${from}`, origin: null, userinfo: false, unread: true, unparsed: false });
      continue;
    }
    for (const start of srcsetStarts(text, from, end)) {
      // What the URL parser strips first: a C0 control (white space has split the candidate).
      let at = start;
      while (at < end && stripped(text[at] ?? "")) at++;
      SRCSET_SCHEME.lastIndex = at;
      const scheme = SRCSET_SCHEME.exec(text);
      at += scheme?.[0].length ?? 0;
      let slashes = 0;
      let forward = false;
      while (at < end && (text[at] === "/" || text[at] === "\\")) {
        if (text[at] === "/") forward = true;
        at++;
        slashes++;
      }
      if (scheme === null && slashes < 2) continue;
      /** @type {UrlStart} */
      const how = scheme !== null ? "scheme" : forward ? "slashes" : "backslashes";
      read((scheme?.[1] ?? "https").toLowerCase(), at, { kind: "srcset", end }, how);
    }
  }
}

/**
 * The URLs a text names, each read as a browser would, in every reading of the text (readings):
 * its origin, or null when it has none the text fixes (a host built at run time), whether it
 * carries a user name or password, whether it ran past what the scanner reads, and whether its
 * host is one the scanner reads but no URL parser takes.
 * @param {string} text
 * @param {{ kind?: string }} [options] "script", "style" or "markup" (the default)
 * @returns {FoundUrl[]}
 */
export function urlsIn(text, options = {}) {
  const kind = options.kind ?? "markup";
  /** @type {Map<string, FoundUrl>} */
  const found = new Map();
  for (const reading of readings(text, kind)) scanReading(reading, kind, found);
  return [...found.values()];
}

/**
 * urlsIn's URLs and the work it did (`visits`: the characters its passes and read-backs
 * visited), stopped with an error once the work passes `limit`: a test's bound on the work, which
 * load cannot trip, in place of a clock's.
 * @param {string} text
 * @param {{ kind?: string, limit?: number }} [options] as urlsIn's, and the bound
 * @returns {{ urls: FoundUrl[], visits: number }}
 */
export function scanWork(text, options = {}) {
  const from = work.visits;
  work.limit = from + (options.limit ?? Infinity);
  try {
    const urls = urlsIn(text, options);
    return { urls, visits: work.visits - from };
  } finally {
    work.limit = Infinity;
  }
}

/**
 * Every file under a directory, as paths relative to it with `/` separators. Links are returned
 * as findings, never followed.
 * @param {string} dir
 * @returns {{ files: string[], links: string[] }}
 */
export function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const links = [];
  /** @param {string} current */
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      const rel = relative(dir, abs).split(sep).join("/");
      if (lstatSync(abs).isSymbolicLink()) links.push(rel);
      else if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) files.push(rel);
      if (files.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files under ${dir}`);
    }
  };
  visit(dir);
  return { files: files.sort(), links: links.sort() };
}

/**
 * The origins named in a text, each once, lower-cased.
 * @param {string} text
 * @param {{ kind?: string }} [options] as urlsIn's
 * @returns {string[]}
 */
export function originsIn(text, options = {}) {
  return [...new Set(urlsIn(text, options).flatMap((u) => (u.origin === null ? [] : [u.origin])))];
}

/**
 * Checks one app's server bundle directory.
 * @param {string} label e.g. apps/api/dist/server
 * @param {string} dir
 * @returns {Finding[]}
 */
export function checkServer(label, dir) {
  /** @type {Finding[]} */
  const findings = [];
  const { files, links } = listFiles(dir);
  for (const link of links) {
    findings.push({ file: `${label}/${link}`, rule: "link", message: "a link in a bundle" });
  }
  for (const file of files) {
    if (!SERVER_FILES.has(extname(file))) continue;
    const text = readFileSync(join(dir, file), "utf8");
    if (file.endsWith(".map")) {
      // A map's sources name every module bundled; its sourcesContent is the original text, whose
      // comments may name anything, so only the paths are read.
      const sources = mapSources(text);
      if (sources === null) {
        findings.push({ file: `${label}/${file}`, rule: "map", message: "a map that is not JSON" });
      } else if (sources.some((s) => s.includes("packages/testing/"))) {
        findings.push({
          file: `${label}/${file}`,
          rule: "seam",
          message: "the test harness (packages/testing) is bundled",
        });
      }
      continue;
    }
    for (const marker of SEAM_MARKERS) {
      if (marker.pattern.test(text)) {
        findings.push({ file: `${label}/${file}`, rule: "seam", message: marker.what });
      }
    }
  }
  return findings;
}

/**
 * The `sources` of a source map, or null when the text is not one.
 * @param {string} text
 * @returns {string[] | null}
 */
export function mapSources(text) {
  try {
    const map = JSON.parse(text);
    if (typeof map !== "object" || map === null || !Array.isArray(map.sources)) return null;
    return map.sources.filter((/** @type {unknown} */ s) => typeof s === "string");
  } catch {
    return null;
  }
}

/**
 * Checks one static build (or staged artefact) directory.
 * @param {string} label e.g. apps/console/dist/static
 * @param {string} dir
 * @param {{ refused?: RefuseMatcher }} [options] the overlay's refuse list, when given
 * @returns {Finding[]}
 */
export function checkStatic(label, dir, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const refused = options.refused ?? refuseMatcher([]);
  const { files, links } = listFiles(dir);
  for (const link of links) {
    findings.push({ file: `${label}/${link}`, rule: "link", message: "a link in a static build" });
  }
  for (const problem of artefactProblems(
    files.map((file) => ({ path: `/${file}`, abs: join(dir, file) })),
    { maps: true },
  )) {
    findings.push({ file: label, rule: "artefact", message: problem });
  }
  for (const file of files) {
    const at = `${label}/${file}`;
    if (isSourceMap(file)) {
      findings.push({ file: at, rule: "source-map", message: "a source map left" });
      continue;
    }
    const bytes = readFileSync(join(dir, file));
    // public-safety's rules, in every reading of the bytes, never printing what matched.
    for (const f of scanContent(at, bytes, refused)) {
      findings.push({
        file: f.line === undefined ? at : `${at}:${f.line}`,
        rule: `public-safety:${f.rule}`,
        message: f.message,
      });
    }
    findings.push(...textFindings(at, file, bytes));
  }
  return findings;
}

/**
 * The text rules for one file of a static build: every file a browser reads as text, and every
 * other file that is not binary (an unknown extension, or none, included).
 * @param {string} at the finding's label
 * @param {string} file the path within the build
 * @param {Buffer} bytes
 * @returns {Finding[]}
 */
function textFindings(at, file, bytes) {
  const ext = extname(file).toLowerCase();
  const decoded = decodeContent(bytes);
  const texts = decoded.binary
    ? STATIC_TEXT_FILES.has(ext)
      ? [bytes.toString("utf8")]
      : []
    : decoded.texts;
  const kind = SCRIPT_FILES.has(ext) ? "script" : ext === ".css" ? "style" : "markup";
  /** @type {Map<string, Finding>} */
  const found = new Map();
  /**
   * @param {string} rule
   * @param {string} message
   */
  const add = (rule, message) => {
    found.set(`${rule}\u{0}${message}`, { file: at, rule, message });
  };
  for (const text of texts) {
    if (/[#@]\s*sourceMappingURL=(?!data:)\S+/.test(text)) {
      add("source-map", "a sourceMappingURL comment points at a map that is never served");
    }
    for (const marker of SEAM_MARKERS) {
      if (marker.pattern.test(text)) add("seam", marker.what);
    }
    for (const marker of SERVER_MARKERS) {
      if (marker.pattern.test(text)) add("server-only", marker.what);
    }
    for (const name of new Set([...text.matchAll(SETTING_NAME)].map((m) => m[0]))) {
      if (SAMPLE_NAMES.has(name)) continue;
      add(
        "setting-name",
        `names the server setting ${clean(name, 60)} (FW-C12: a build takes public settings only)`,
      );
    }
    for (const u of urlsIn(text, { kind })) {
      if (u.unread) {
        add(
          "url-unread",
          `a URL whose host, or a srcset that does not close, runs past ${MAX_AUTHORITY} (srcset ${MAX_SRCSET}) characters: too long to read as a browser does`,
        );
      }
      if (u.unparsed) {
        add(
          "url-unparsed",
          "a URL whose host the scanner reads but a URL parser refuses: a browser may read it otherwise, so it is not passed as a host built at run time",
        );
      }
      if (u.userinfo) {
        add(
          "url-userinfo",
          "a URL with a user name or password, whose host is not the one it seems to name",
        );
      }
      if (u.origin !== null && !ALLOWED_ORIGINS.has(u.origin)) {
        add("third-party-origin", `names ${clean(u.origin, 120)}`);
      }
    }
  }
  return [...found.values()];
}

/**
 * Runs both checks over every built app under <root>/apps.
 * @param {string} root
 * @param {{ refused?: RefuseMatcher }} [options]
 * @returns {{ server: number, static: number, findings: Finding[] }}
 */
export function checkBundles(root, options = {}) {
  const appsDir = join(root, "apps");
  /** @type {Finding[]} */
  const findings = [];
  let server = 0;
  let statics = 0;
  if (!existsSync(appsDir)) return { server, static: statics, findings };
  for (const app of readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const serverDir = join(appsDir, app.name, "dist", "server");
    if (existsSync(serverDir)) {
      server++;
      findings.push(...checkServer(`apps/${app.name}/dist/server`, serverDir));
    }
    const staticDir = join(appsDir, app.name, "dist", "static");
    if (existsSync(staticDir)) {
      statics++;
      findings.push(...checkStatic(`apps/${app.name}/dist/static`, staticDir, options));
    }
  }
  return { server, static: statics, findings };
}

/**
 * Checks every static artefact staged under a directory, one per folder (release.yml).
 * @param {string} dir
 * @param {{ refused?: RefuseMatcher }} [options]
 * @returns {{ server: number, static: number, findings: Finding[] }}
 */
export function checkArtefacts(dir, options = {}) {
  /** @type {Finding[]} */
  const findings = [];
  let statics = 0;
  if (!existsSync(dir)) return { server: 0, static: 0, findings };
  for (const name of readdirSync(dir).sort()) {
    const label = `artefact ${name}`;
    const abs = join(dir, name);
    if (!lstatSync(abs).isDirectory()) {
      findings.push({
        file: label,
        rule: "artefact",
        message: "not a folder of a staged artefact",
      });
      continue;
    }
    statics++;
    findings.push(...checkStatic(label, abs, options));
  }
  return { server: 0, static: statics, findings };
}

if (isMain(import.meta)) {
  const argument = (/** @type {string} */ flag) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  const options = { refused: refuseMatcher(loadRefuseList(process.env.FIN_OVERLAY_FILE)) };
  const artefacts = argument("--artefacts");
  const result =
    artefacts === undefined
      ? checkBundles(argument("--root") ?? process.cwd(), options)
      : checkArtefacts(artefacts, options);
  if (result.server + result.static === 0) {
    annotate("notice", "bundle-check", "no app has a built server bundle or static build yet");
  }
  for (const f of result.findings) say(`bundle-check: ${clean(f.file)}: ${f.rule}: ${f.message}`);
  say(
    `bundle-check.result result=${result.findings.length === 0 ? "pass" : "fail"} server=${result.server} static=${result.static} findings=${result.findings.length}`,
  );
  process.exitCode = result.findings.length === 0 ? 0 : 1;
}
