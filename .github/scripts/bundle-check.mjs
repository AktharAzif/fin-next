#!/usr/bin/env node
// The build job's bundle checks, and the release's scan of each static artefact (spec 01 §5.3;
// ARCHITECTURE §3.4 FW-C12, §3.5, §11.2, §11.7; FW-C04, FW-C05). A control path.
//
// How a script is read. A JavaScript file (.js, .mjs, .cjs) is read through the shared tokenizer
// (scripts/js-tokens.mjs), never with text patterns over its source: a pattern cannot tell a
// regular expression from a division, a comment from code, or where a template literal's
// substitution ends. Every rule below reads a script's TOKENS: the literal values a script holds
// (each string's decoded value, and a template literal's static text with each substitution
// marked as code), the names and punctuators around them, and its comments where a rule is about
// comments (a bundler's module comments, a sourceMappingURL, a seam's marker). A regular
// expression or a comment is never read as text a page could load. A script the tokenizer cannot
// read is refused whole (untokenized), never scanned in part. A JSON file (.json, .webmanifest)
// is read through JSON.parse, its strings (keys included) as a script's literals are; one that
// does not parse is read as the text it is. Markup, stylesheets and every other file are text,
// not JavaScript, and are read as text.
//
//   server bundles (apps/<app>/dist/server/**), the release target CI builds by default
//     - no test seam in the JavaScript (ARCHITECTURE §3.5: CI greps the release bundles for the
//       seams' markers): the build-target define left unreplaced (`__FIN_BUILD_TARGET__`, a name
//       or a literal: only code shows the define was not compiled in), the `fin:test-seam` marker
//       a seam module carries wherever it stands, as a grep finds it: in a literal, a regular
//       expression or a comment (Vite drops a literal the module never uses and keeps a legal
//       comment, `/*! fin:test-seam */`, so a comment is the form that reaches a bundle), a module
//       comment of packages/testing (the harness bundled in: Vite's `// <path>` and
//       `//#region <path>`), or an import of @fin/testing left in (a specifier after `from` or
//       `import`, or the one argument of a dynamic import or a require call);
//     - no packages/testing source in a map's `sources` (its sourcesContent, the original text
//       with its comments, is not read);
//   static builds (apps/<app>/dist/static/**), and with --artefacts <dir> each folder in <dir>
//   (release.yml: every staged static artefact, the previous release's carried assets included)
//     - FW-C12's scan: no secret shape and nothing public-safety refuses in any file, read with
//       scripts/public-safety.mjs's own rules (and the overlay's refuse list when FIN_OVERLAY_FILE
//       names one); and, in every file a browser reads as text (STATIC_TEXT_FILES) and every
//       other file that is not binary (an unknown extension, or none): no server setting's name
//       (`FIN_*`, in a script's names, literals and regular expressions, elsewhere in the text: a
//       build takes public settings only, and env.json's fields are not named so; the samples'
//       shell variables the plan names, SAMPLE_NAMES, are no setting's); no server-only marker (a
//       script's import of a `node:` module, or Vite's stand-in for one,
//       `__vite-browser-external`); no test seam marker. An import in markup or JSON is text,
//       never code (a guide's sample), since the page policy runs no inline script;
//     - in the same files, no third-party origin. In a script, every literal is read: every
//       http, https, ws or wss URL in its text; every `://` in its text that no scheme the text
//       fixes stands before (`${s}://host`, `"{scheme}://host"`, `"%s://host"`, a web scheme's end
//       at a literal's start, which the code before it wrote: `p+"s://host"`); every
//       protocol-relative one where a URL starts (a literal's own start, the text right after a
//       substitution, an unquoted attribute's `=` in a start tag the literals write, an
//       attribute's quote, CSS's url(, a refresh's content, a srcset candidate); and every host
//       a script joins to such a URL from literals or chooses among them, in any context
//       (`"https://"+"host"`, `` `https://${p?`a.host`:`b.host`}` ``, `(p?"a":"b")+".host"`,
//       `"//"+(p?"a.host":"b.host")`; after two slashes, a joined host counts only where a browser
//       reaches it on the network). A start tag is followed through every literal of the script in
//       source order, as an HTML tokenizer reads it: a template literal's substitution, and the
//       code between two literals a concatenation, a list, a call, a condition or `+=` joins
//       (within MAX_PIECE_GAP characters of code), may write any text, so the tag goes on in the
//       next literal. Past a statement's end it goes on only where a later statement joins a
//       string an earlier one began (a variable that holds a tag's start): a literal after `+` or
//       `+=`, any joined literal of a `+=` statement, a literal at a substitution's start, a
//       template literal that starts with a substitution, and `.concat(`'s arguments
//       (`const n="<a "+t;e.innerHTML=n+" href=..."`, `` `${n} href=...` ``). A srcset list is
//       read where a key names it (`srcSet:`, `.srcset=`, `setAttribute("srcset",`, a call's later
//       argument that is exactly an attribute's name, `attr(e,"srcset",`, `"srcset":`, and every
//       literal in the value such a key is given), where markup or JSON in a literal opens it, and
//       where a literal's text has a srcset list's shape (a descriptor, or candidates shaped as
//       URLs, before a comma), a host there counting only where a browser reaches it on the network
//       (prose's `"a, b, //c"` names none). In markup and stylesheets, every such URL where a URL
//       starts (after a quote, an unquoted attribute's `=`, CSS's url(, a refresh's time, as a
//       srcset candidate; and after any C0 control or space, which the URL parser strips first).
//       Each has an origin on ALLOWED_ORIGINS, the namespace and message URLs the pinned libraries
//       carry, none of which is fetched; and no URL has a user name or password, whose host is
//       not the one it seems to name. Each URL is read as a browser reads it, in every reading of
//       the text a browser may apply (a literal's value, which the tokenizer decodes, and HTML's
//       character references and CSS's escapes over it, one after another where a browser
//       applies them in turn, as to a style attribute a script writes; a tagged template's raw
//       text too, which its tag reads; in markup also JavaScript's escapes; a character a
//       reference or a CSS escape spells is data to the markup's or the stylesheet's tokenizer,
//       never a value's or a tag's end): its scheme in any case, a backslash as a slash, any run
//       of slashes, no slashes at all where a literal starts (`"wss:host"`), tabs and new lines
//       dropped, and its authority everything up to the first /, \, ? or # or where the browser
//       ends its literal (the literal's own end; an attribute's closing quote; ASCII white space
//       or `>` after an unquoted attribute; ASCII white space or `)` in an unquoted url(; ASCII
//       white space in a srcset; the end of a refresh's value), less the C0 controls and spaces
//       the URL parser strips at its end, the host after its last `@`. White space after the
//       slashes is the URL's own. A quote inside a value may close it or be the URL's own, so the
//       URL is read both up to it and past it. A URL whose authority (or a srcset list) runs past
//       what the scanner reads, or, after a scheme the text fixes, whose host it reads but a URL
//       parser refuses, is refused, never read as its first part names or passed as a host built
//       at run time. With no scheme in the text, such a host loads nothing and is no finding,
//       and backslashes alone or a scheme written at run time name a host only where it has a dot
//       or is an IP address (a pattern's `\\n` names none). Where only a guess says a URL starts
//       (right after a substitution, a refresh whose time a script writes), a host no URL parser
//       takes is no finding, and a refresh written at run time with no `url=` names only a host
//       on the network unless a refresh key (http-equiv refresh, or a `refresh` property's name)
//       stands near. A host a script builds at run time from a name or a call
//       (`"https://" + host`, `https://${host}`), or whose literal text is only its start, a
//       single label with or without a dot after it (`https://api.${zone}`, `"https://www."+host`),
//       is not read here: the page's own policy refuses it in the browser. The work is linear in
//       the text, counted, not timed (scanWork);
//     - no source map (`*.map` in any case, or a `sourceMappingURL` comment pointing at one);
//     - nothing a deployment refuses (release-static.mjs's artefactProblems: `_headers` or
//       `env.json`, which the deploy renders, SF-05; a Worker control file; a path read two ways;
//       an asset over 25 MiB);
//   and no link anywhere. The built index.html's inline scripts, handlers and the rest of FW-C04
// are scripts/static-check.mjs's, which the build job runs next; gitleaks scans the same folders
// (gitleaks-static.sh). While no app has been built, the check passes with a notice.
//
// `process.env` is not refused: isomorphic libraries guard it with `typeof process`, and a server
// configuration module is caught by its settings' names instead.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { TokenizeError, tokenize } from "../../scripts/js-tokens.mjs";
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
/** @typedef {import("../../scripts/js-tokens.mjs").Token} Token */

// ---- markers -----------------------------------------------------------------------------------

/** What each marker of a test seam or of server-only code means. */
const WHAT = {
  target: "the build target was not compiled in",
  seam: "a test seam's marker",
  region: "the test harness (packages/testing) is bundled",
  harness: "the test harness (@fin/testing) is imported",
  node: "a node: module is imported (FW-C12: client code imports no node:*)",
  external: "Vite's stand-in for a Node module (client code imported one)",
};
const BUILD_TARGET = /\b__FIN_BUILD_TARGET__\b/;
const SEAM_MARK = "fin:test-seam";
const BROWSER_EXTERNAL = "__vite-browser-external";
/**
 * A bundler's module comment, as a script holds it: Vite 8.3.8's `// <path>` and rolldown's
 * `//#region <path>`, the comment's text one path.
 */
const MODULE_COMMENT = /^(?:#region)?[\t ]+(\S+)[\t ]*$/;
/** A harness module's path, as a module comment or a map names it. */
const HARNESS_PATH = "packages/testing/";
/** The harness package's specifier, and a Node built-in's. */
const HARNESS_SPECIFIER = /^@fin\/testing(?:\/.*)?$/s;
const NODE_SPECIFIER = /^node:\S+$/;

/**
 * The markers a file that is not JavaScript (markup, a stylesheet, JSON, an unknown extension)
 * may hold, which has no tokens: the marker's text wherever it stands. An import there is text,
 * never code (a guide's sample: `import { createHmac } from "node:crypto"`), since the page policy
 * runs no inline script, so no import is read in it.
 */
const TEXT_MARKERS = [
  { rule: "seam", pattern: BUILD_TARGET, what: WHAT.target },
  { rule: "seam", pattern: /fin:test-seam/, what: WHAT.seam },
  {
    rule: "seam",
    pattern: /^\/\/#region\s+\S*packages\/testing\//m,
    what: WHAT.region,
  },
  { rule: "server-only", pattern: /__vite-browser-external/, what: WHAT.external },
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
/** A sourceMappingURL that points at a map: in a script, a comment's text; elsewhere, the text. */
const MAP_COMMENT = /^[#@]\s*sourceMappingURL=(?!data:)\S+/;
const MAP_TEXT = /[#@]\s*sourceMappingURL=(?!data:)\S+/;

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
/** Scripts, read through the tokenizer; and JSON, read through JSON.parse. */
const SCRIPT_FILES = new Set([".js", ".mjs", ".cjs"]);
const JSON_FILES = new Set([".json", ".webmanifest"]);
const MAX_FILES = 50_000;

/**
 * The scanner's work, counted as the characters and tokens its passes and read-backs visit (a
 * search the runtime makes over the text counts as the characters it passes), so a test bounds it
 * by a multiple of the text's length with no clock (scanWork): load slows a run, never adds to its
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

// ---- readings: a text as a browser may read it -------------------------------------------------

/**
 * One reading of a text (readings): the text with one kind of escape read; which characters an
 * escape or a character reference spelled (`spelled[i] === 1`), which are data to the tokenizer
 * that reads the markup or the stylesheet: such a character never ends a value, opens or ends a
 * tag, a quote or a url( (`&gt;`, `&#32;`, `\9 `), while the URL parser, which reads the value
 * after them, reads it as itself; and, in a template literal's text, where each substitution
 * stands (`subst[i] === 1`, one SUBST character each), code that writes text at run time.
 * @typedef {{ text: string, spelled: Uint8Array | null, subst: Uint8Array | null }} Reading
 */

/** What stands for a template literal's substitution in its text (Reading's `subst`). */
const SUBST = "\u{ffff}";
const QUOTES = new Set(['"', "'", "`"]);
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
 * A text with the escapes a pattern finds read, and which characters they spelled. Over a reading
 * that is itself spelled (CSS's escapes in a style attribute, after HTML's references), a
 * character the earlier reading spelled stays spelled where it is copied unchanged, and so does a
 * substitution's mark.
 * @param {string | Reading} input
 * @param {string} lead the character every escape starts with
 * @param {RegExp} pattern a global pattern
 * @param {(m: RegExpExecArray) => string} decode an escape's text, or the match unchanged
 * @returns {Reading}
 */
function readEscapes(input, lead, pattern, decode) {
  /** @type {Reading} */
  const reading = typeof input === "string" ? { text: input, spelled: null, subst: null } : input;
  const { text, spelled: before, subst: beforeSubst } = reading;
  // A text with no escape's first character reads as it stands: the same reading.
  if (!text.includes(lead)) {
    spend(text.length);
    return reading;
  }
  // An escape is two characters or more and spells two code units at most. A mark the earlier
  // reading has is copied; a new one is made once a character needs it.
  /** @type {Uint8Array | null} */
  let spelled = before === null ? null : new Uint8Array(text.length);
  const subst = beforeSubst === null ? null : new Uint8Array(text.length);
  let out = "";
  let last = 0;
  /** @param {number} from @param {number} to */
  const copy = (from, to) => {
    if (from < to) {
      if (before !== null) spelled?.set(before.subarray(from, to), out.length);
      if (beforeSubst !== null) subst?.set(beforeSubst.subarray(from, to), out.length);
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
    subst: subst === null ? null : subst.subarray(0, out.length),
  };
}

const JS_ESCAPE =
  /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\s\S]))/g;
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g;
const HTML_REFERENCE = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]{1,31}));?/g;

/**
 * Markup read as a script's text might be (an inline script, a file of an unknown kind): through
 * JavaScript's escapes (`\/`, `\x2f`, `\u{2f}` with any number of leading zeros, `\0` and a
 * classic script's octal escapes, the rest; a line continuation dropped), each character one
 * spelled. A script itself is never read so: the tokenizer decodes its literals.
 * @param {string} text
 * @returns {Reading}
 */
function readJsEscapes(text) {
  return readEscapes(text, "\\", JS_ESCAPE, ([, braced, u4, x2, octal, other]) => {
    const hex = braced ?? u4 ?? x2;
    if (hex !== undefined) return fromJsCode(Number.parseInt(hex, 16));
    if (octal !== undefined) return fromJsCode(Number.parseInt(octal, 8));
    if (/^(?:\r\n|[\n\r\u{2028}\u{2029}])$/u.test(other ?? "")) return "";
    return JS_ESCAPES.get(other ?? "") ?? other ?? "";
  });
}

/**
 * A text with CSS's escapes read (`\2f`, `\2f ` and `\/`; an escaped new line is dropped), and
 * which characters they spelled (with those an earlier reading spelled, over a Reading).
 * @param {string | Reading} text
 * @returns {Reading}
 */
function readCssEscapes(text) {
  return readEscapes(text, "\\", CSS_ESCAPE, ([, hex, newline, other]) => {
    if (hex !== undefined) return fromCode(Number.parseInt(hex, 16));
    if (newline !== undefined) return "";
    return other ?? "";
  });
}

/**
 * A text with HTML's character references read: every numeric one (with any number of leading
 * zeros), and the named ones that spell a URL's punctuation (`&sol;`, `&colon;`, `&commat;`,
 * `&Tab;` and the rest); and which characters they spelled.
 * @param {string | Reading} text
 * @returns {Reading}
 */
function readHtmlReferences(text) {
  return readEscapes(text, "&", HTML_REFERENCE, ([whole, decimal, hex, name]) => {
    if (decimal !== undefined) return fromCode(Number.parseInt(decimal, 10));
    if (hex !== undefined) return fromCode(Number.parseInt(hex, 16));
    return NAMED_REFERENCES.get(name ?? "") ?? whole;
  });
}

/**
 * Whether a reading's character at an index was spelled by a reference or an escape.
 * @param {Reading} reading
 * @param {number} i
 */
const isSpelled = (reading, i) => reading.spelled !== null && reading.spelled[i] === 1;

/**
 * Whether a reading's character at an index stands for a template literal's substitution.
 * @param {Reading} reading
 * @param {number} i
 */
const isSubst = (reading, i) =>
  reading.subst !== null && reading.subst[i] === 1 && !isSpelled(reading, i);

/**
 * Whether two readings are the same text, read the same way.
 * @param {Reading} a
 * @param {Reading} b
 */
const sameReading = (a, b) => {
  if (a === b) return true;
  /** @param {Uint8Array | null} x @param {Uint8Array | null} y */
  const same = (x, y) =>
    x === null || y === null ? x === y : Buffer.from(x).equals(Buffer.from(y));
  return a.text === b.text && same(a.spelled, b.spelled) && same(a.subst, b.subst);
};

/**
 * The readings a browser may apply to a text, each once: as it stands, through HTML's references
 * (markup it writes), CSS's escapes (CSS it holds: `element.style`, `insertRule`, a stylesheet a
 * string fills) and both in turn (a style attribute in markup); markup, and any other file that
 * is not JavaScript, also through JavaScript's escapes first, as an inline script would read.
 * @param {Reading} base
 * @param {boolean} js whether JavaScript's escapes may apply first (markup)
 * @returns {Reading[]}
 */
function readingsOf(base, js) {
  /** @type {Reading[]} */
  const all = [];
  /** @param {Reading} r */
  const add = (r) => {
    if (!all.some((o) => sameReading(o, r))) all.push(r);
  };
  const html = readHtmlReferences(base);
  add(base);
  add(html);
  /** @type {Reading[]} */
  const more = [base, html];
  if (js) {
    const script = readJsEscapes(base.text);
    const scriptHtml = readHtmlReferences(script);
    add(script);
    add(scriptHtml);
    more.push(script, scriptHtml);
  }
  for (const r of more) add(readCssEscapes(r));
  return all;
}

// ---- reading a URL as a browser does -----------------------------------------------------------

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
/** A srcset attribute's value in markup, quoted or not (the separator, then the quote or none). */
const SRCSET = /srcset[ \t\n\r\f]*(=)[ \t\n\r\f]*(["']?)/gi;
/**
 * In a literal's text, also a srcset list a key opens: markup's attribute, JSON's key (`"srcset":"`,
 * `{\"srcset\":\"...\"}` in a string a script parses), a property's in code a string holds.
 */
const LITERAL_SRCSET = /srcset[ \t\n\r\f]*(?:["'`][ \t\n\r\f]*)?([=:,])[ \t\n\r\f]*(["'`]?)/gi;
/** A srcset candidate's scheme, after what the URL parser strips first. */
const SRCSET_SCHEME = /(https?|wss?):/iy;
/**
 * The longest authority, and srcset value with no closing quote (or a template literal's list
 * that spans more source), the scanner reads: a bound on its work only. A URL that runs past it
 * is a finding (url-unread), never read as what its first part names.
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
 * Whether CSS's unquoted url( holds a character only as a bad URL, which loads nothing: a quote,
 * `(`, and a non-printable code point.
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
 * slashes start a URL there only as the text wrote them, never as a reference or a CSS escape
 * spells them; `network`: a host there counts only where a browser reaches it on the network,
 * networkHost). A quoted context whose `end` is "" is a literal's own: the literal's end ends it.
 * @typedef {({ kind: "quoted", end: string, spelled: boolean }
 *   | { kind: "srcset", end: number }
 *   | { kind: "attribute" | "css" | "none" })
 *   & { guessed?: boolean, raw?: boolean, network?: boolean }} UrlContext
 */

/**
 * What scanReading knows of where its text stands: markup, a stylesheet, or a script's literal
 * (or a JSON string), with, for a literal, whether an `=` at an index gives an attribute its value
 * in a start tag the literals write (`inTag`), the hosts the code joins to a URL that reaches the
 * literal's end or a substitution (`extend`, null where nothing is joined), whether a refresh key
 * stands near an index (`refreshNear`), whether a key in the code names the literal a srcset list
 * (`keyed`), and how far its source spans (`span`).
 * @typedef {object} Where
 * @property {"markup" | "style" | "literal"} kind
 * @property {(eq: number) => boolean} inTag
 * @property {((reads: AuthorityRead[], context: UrlContext, depth: number) => AuthorityRead[]) | null} extend
 * @property {(at: number) => boolean} refreshNear
 * @property {boolean} keyed
 * @property {boolean} template whether the literal is a template literal
 * @property {number} span
 */

/**
 * What stands before a URL, which decides where its text ends: a quote (or a quote an escape
 * spelled), a literal's own start, the `=` of an unquoted attribute (anywhere in markup; in a
 * start tag a script's literals write, inTag), CSS's `url(`, or nothing known. Whatever the URL
 * parser strips first (a C0 control or a space) is passed over. A `=` or `(` a reference or an
 * escape spelled is data, and starts nothing.
 * @param {Reading} reading
 * @param {number} index where the URL starts
 * @param {Where} where
 * @returns {UrlContext}
 */
function contextBefore(reading, index, where) {
  const { text } = reading;
  let i = index - 1;
  while (i >= 0 && stripped(text[i] ?? "")) i--;
  spend(index - i);
  if (i < 0) {
    return where.kind === "literal"
      ? { kind: "quoted", end: "", spelled: false }
      : { kind: "none" };
  }
  if (isSubst(reading, i)) return { kind: "none" };
  const c = text[i] ?? "";
  const spelled = isSpelled(reading, i);
  if (QUOTES.has(c)) return { kind: "quoted", end: c, spelled };
  if (spelled) return { kind: "none" };
  if (c === "=" && (where.kind === "markup" || (where.kind === "literal" && where.inTag(i)))) {
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
 * Where a refresh's value starts, and how it is written (refreshStart): `named` when `url=`
 * stands before the URL, `written` when a script writes its time at run time. `at` is -1 for a
 * literal's own start.
 * @typedef {{ at: number, named: boolean, written: boolean }} RefreshStart
 */

/** How far before a refresh written at run time a refresh key counts as its own. */
const REFRESH_REACH = 256;

/**
 * Where the value starts whose refresh URL (HTML's shared declarative refresh steps) starts at
 * an index, or null: the value's start, ASCII white space, a time of digits and dots (a digit in
 * it: prose's `'a'.` is no time), `;`, `,` or white space, white space, an optional `url=`, then
 * what the URL parser strips first (a C0 control or a space). In a script's literal, a time
 * written at run time is read too (`written`), with `url=` or without it as a browser reads it
 * (`` `${n}; //host/x` ``): a substitution right before the separator (`` `${n}; url=...` ``) or
 * before the time's digits (`` `${n}0; //host/x` ``), or the literal's own start, the code before
 * it having written the time (`n+"; url=..."`); and `url=` at the literal's start, the time and its
 * separator written apart (`[n,"url=//host/x"].join(";")`). A comment's `; // note` reads a host
 * that starts with white space, which no host does. Read back from the URL with no bound: each run
 * it passes holds no URL's start (a scheme's letter or a slash), so the runs read back from two
 * URLs never overlap and the work stays linear.
 * @param {Reading} reading
 * @param {number} index
 * @param {Where} where
 * @returns {RefreshStart | null}
 */
function refreshStart(reading, index, where) {
  const { text } = reading;
  const literal = where.kind === "literal";
  const space = (/** @type {number} */ k) => ASCII_SPACE.has(text[k] ?? "");
  // The literal's own start: the code before it wrote what stands before.
  const opening = (/** @type {number} */ k) => literal && k < 0;
  const written = (/** @type {number} */ k) => literal && k >= 0 && isSubst(reading, k);
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
  const named = i >= 0 && text[i] === "=";
  if (named) {
    i--;
    while (i >= 0 && space(i)) i--;
    if (i < 2 || text.slice(i - 2, i + 1).toLowerCase() !== "url") return done(null);
    i -= 3;
    const before = i;
    while (i >= 0 && space(i)) i--;
    sep = i < before;
    if (opening(i)) return done({ at: -1, named, written: true });
  } else {
    sep = gap;
  }
  if (i >= 0 && (text[i] === ";" || text[i] === ",")) {
    i--;
    while (i >= 0 && space(i)) i--;
    sep = true;
  }
  // A time ends at the separator: white space right after it, or `;` or `,`.
  if (!sep || !(space(i + 1) || text[i + 1] === ";" || text[i + 1] === ",")) return done(null);
  if (written(i)) return done({ at: i, named, written: true });
  if (opening(i)) return done({ at: -1, named, written: true });
  let digit = false;
  while (i >= 0 && TIME.test(text[i] ?? "")) {
    if (text[i] !== ".") digit = true;
    i--;
  }
  if (!digit) return done(null);
  if (written(i)) return done({ at: i, named, written: true });
  while (i >= 0 && space(i)) i--;
  if (opening(i)) return done({ at: -1, named, written: false });
  return done(VALUE_START.has(text[i] ?? "") ? { at: i, named, written: false } : null);
}

/**
 * Every context a URL may be in (contextBefore's, and each reading a browser may apply instead),
 * so its end is read in each and none is dropped. Beside the first: a later candidate of a srcset
 * list no key opens, after a descriptor (`c?"/a.png 1x, https://host/b.png 2x":x`;
 * descriptorBefore) or, in a literal, in a list its text holds (`c?"/a.png, //host/b.png 2x":x`;
 * inList), which runs to ASCII white space; the text right after a template literal's
 * substitution (`${a} https://host/`, past what the URL parser strips), which runs to the
 * literal's end; and a refresh's URL (`content="0;https://host/"`), which runs to the end of the
 * value (to the literal's end where the code or a substitution wrote the time). The last two are
 * guessed: a host read in them that no URL parser takes is no finding (the first context's
 * reading still is), and two slashes start a URL there only as the text wrote them (`raw`). A
 * refresh a script writes with no `url=` names only a host a browser reaches on the network
 * (`network`), unless a refresh key stands near: a code generator's `";//eslint-disable-line"`
 * names no refresh's host.
 * @param {Reading} reading
 * @param {number} index where the URL starts
 * @param {Where} where
 * @param {(comma: number) => boolean} inList whether the comma at an index ends a candidate of a
 *   srcset list a literal's text holds (srcsetListBefore)
 * @returns {UrlContext[]}
 */
function contextsBefore(reading, index, where, inList) {
  const { text } = reading;
  const literal = where.kind === "literal";
  /** @type {UrlContext[]} */
  const all = [contextBefore(reading, index, where)];
  let before = index - 1;
  while (before >= 0 && stripped(text[before] ?? "")) before--;
  spend(index - before);
  if (
    all[0]?.kind === "none" &&
    before >= 0 &&
    text[before] === "," &&
    (descriptorBefore(text, before) || (literal && inList(before)))
  ) {
    // A list read by its shape alone names only a host on the network: prose and code samples
    // (`"a, b, //c"`, `"timeout: 30, //seconds"`) name none.
    all.push({ kind: "srcset", end: text.length, network: true });
  }
  if (literal && before >= 0 && isSubst(reading, before)) {
    all.push({ kind: "quoted", end: "", spelled: false, guessed: true, raw: true });
  }
  const start = refreshStart(reading, index, where);
  if (start !== null) {
    const { at, named, written } = start;
    /** @type {{ guessed: true, raw?: boolean, network?: boolean }} */
    const how = written
      ? { guessed: true, raw: true, network: !named && !where.refreshNear(at) }
      : { guessed: true };
    if (at < 0 || isSubst(reading, at)) {
      // The literal's own start, or a substitution, wrote the time: the value is the literal's.
      all.push({ kind: "quoted", end: "", spelled: false, ...how });
    } else {
      const c = text[at] ?? "";
      const spelled = isSpelled(reading, at);
      if (QUOTES.has(c)) {
        all.push({ kind: "quoted", end: c, spelled, ...how });
      } else if (!spelled && (where.kind === "markup" || (literal && where.inTag(at)))) {
        all.push({ kind: "attribute", ...how });
      }
    }
  }
  return all;
}

/**
 * An authority as one reading reads it: `cut` when it ran past MAX_AUTHORITY; `crossed` when it
 * was read past where the literal may end, or in a guessed context; `built` when a template
 * literal's substitution stands in it or right after it, or code goes on with it; `end`, where
 * readAuthority stopped (the literal's end, a substitution, a quote, or what else ended it), so the
 * code's joins may go on from there (Where's `extend`); `joined` when a join gave it.
 * @typedef {{ authority: string, cut: boolean, crossed: boolean, built: boolean, end?: number,
 *   joined?: boolean }} AuthorityRead
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
    if (isSubst(reading, i)) break;
    if (c === "\t" || c === "\n" || c === "\r") {
      if (isSpelled(reading, i)) continue;
      break;
    }
    if (ASCII_SPACE.has(c) || "/\\?#".includes(c)) break;
    if (QUOTES.has(c) && !isSpelled(reading, i)) break;
    if (c === ">" && !isSpelled(reading, i)) keep(on);
    on += c;
  }
  spend(i - from + 1);
  keep(on);
  return reads;
}

/**
 * A URL's authority as a browser reads it: everything up to the first `/`, `\`, `?` or `#`, or the
 * end of its literal where the browser ends it, with tabs and new lines dropped where they are
 * the URL's own (in a quoted literal, or spelled by a reference or an escape). The literal ends
 * at its closing quote (or a script literal's own end); at ASCII white space or `>` after an
 * unquoted attribute; at ASCII white space, `)` or what makes a bad URL in CSS's url(; at ASCII
 * white space in a srcset candidate; and, where nothing known starts the URL (it is not a
 * literal's start), at white space (not a byte order mark, which the host parser drops), quotes
 * and brackets, and read on for a user name (userNamePast). A character a reference or an escape
 * spelled never ends a literal. A quote inside a value may close a value its other spelling
 * opened, or be the URL's own: the authority is read both up to it and past it (`crossed`). In a
 * template literal, a substitution writes text at run time: the authority is read both up to it,
 * which names the host when one stands before it, and past it (`built`). `cut` when it ran past
 * MAX_AUTHORITY instead.
 * @param {Reading} reading
 * @param {number} start
 * @param {UrlContext} context
 * @returns {AuthorityRead[]}
 */
function readAuthority(reading, start, context) {
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
    if (isSubst(reading, i)) {
      // The read up to the first substitution names the fixed part before it; past it, the host is
      // built at run time, and so is every read that holds it.
      if (!built) reads.push({ authority, cut: false, crossed, built: true, end: i });
      built = true;
      authority += "${";
      continue;
    }
    // A srcset is split on its value's white space, a reference's included.
    if (context.kind === "srcset" && ASCII_SPACE.has(c)) break;
    if (c === "\t" || c === "\n" || c === "\r") {
      if (spelled || context.kind === "quoted") continue;
      break;
    }
    if ("/\\?#".includes(c)) break;
    if (
      context.kind === "quoted" &&
      context.end !== "" &&
      c === context.end &&
      spelled === context.spelled
    ) {
      break;
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
        reads.push({ authority, cut: false, crossed, built, end: i });
        crossed = true;
      } else if (context.kind === "attribute" && (c === " " || c === "\f" || c === ">")) {
        break;
      }
    }
    authority += c;
  }
  spend(i - start + 1);
  reads.push({ authority, cut: false, crossed, built, end: i });
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
 * between two labels (an IPv4 address in any spelling is written with dots) or is an IPv6
 * address. A single label, with or without a root dot after it (`www.`, a host's start), names no
 * host anyone outside the network holds.
 * @param {string} hostname
 */
const networkHost = (hostname) =>
  hostname.replace(/\.$/, "").includes(".") || hostname.startsWith("[");

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
    // refuses it in the browser), a reading past a quote that may end the value or in a guessed
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
  // Read past a quote that may end the value, the host's last label holds the quote and the text
  // after it: no top-level domain holds a quote, so a host whose last label does is none a
  // browser could load either way.
  if (crossed && /["'`]/.test(url.hostname.replace(/\.$/, "").split(".").at(-1) ?? "")) {
    return null;
  }
  // A host a substitution stands in is built at run time; the reading up to the substitution
  // names the fixed part before it, when there is one. Where the code goes on building the host
  // right after the text read (a substitution, or code its literal is joined to), a single
  // label, with or without a dot after it, is only the host's start (`https://api.${zone}`,
  // `"https://www."+host`): that host is built at run time too. A port's `:` ends the host.
  const hostStart = built && !/:[0-9]*$/.test(read) && !networkHost(url.hostname);
  const runTime =
    !/[A-Za-z0-9]/.test(url.hostname) || (built && url.hostname.includes("${")) || hostStart;
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

/**
 * A srcset candidate's descriptor: a density, a width or a height. Spelled with no two parts that
 * may take the same digits, so a long run of digits is read in linear time.
 */
const DESCRIPTOR = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[xwh]$/;

/**
 * Whether a comma ends a candidate of a srcset list no key opens (a constant, a condition's
 * branch: `c?"/a.png 1x, //host/b.png 2x":x`), so a URL after it is a later candidate: a
 * descriptor (`2x`, `640w`, `1e1x`, `${dpr}x`) after ASCII white space stands right before it,
 * which code never writes. Each comma reads back one run, never past the comma before it, so the
 * work stays linear.
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
  const run = text.slice(start + 1, end + 1).replaceAll(SUBST, "1");
  return start < end && ASCII_SPACE.has(text[start] ?? "") && DESCRIPTOR.test(run);
}

/** What a value may open after inside a literal's text, past ASCII white space. */
const VALUE_AFTER = new Set([..."(,:=[{?&|+"]);

/**
 * A srcset candidate's URL in a list no key opens, each substitution read as a word: a path, a
 * relative path or a word's start, and nothing code holds (a bracket, a brace, `<`, `>`, `;`, a
 * backslash, a quote, `^`, `|`, `*` or `$`).
 */
const CANDIDATE_URL = /^(?:\.{0,2}\/|\w)[^()[\]{}<>;\\"'`^|*$]*$/u;
/** A descriptor, misspelled ones included (`2X`, `100px`, `1.5dppx`): a number first. */
const DESCRIPTOR_LIKE = /^\.?[0-9][0-9A-Za-z.+-]*$/;

/**
 * Whether a comma ends a candidate of a srcset list a literal's text holds where no srcset key
 * opens it (a condition's branch, a default, a constant, an object's value, a helper's argument:
 * `c?"/a.png, //host/b.png 2x":x`), so a URL after it is a later candidate. The list is read back
 * piece by piece (split at commas) from the comma to the literal's start, or to a quote in its
 * text that opens a value (markup or JSON the literal holds): each piece is one candidate, its URL
 * (CANDIDATE_URL, a substitution read as a word) and descriptors after white space, misspelled
 * ones included (DESCRIPTOR_LIKE); an empty piece (`,,`) is passed over. Each comma passed is
 * remembered with the answer, so each piece is read back once and the work stays linear. A list
 * a key opens is read whole, whatever it holds.
 * @param {Reading} reading
 * @param {number} comma
 * @param {Map<number, boolean>} known the answers so far, for this text
 */
function srcsetListBefore(reading, comma, known) {
  const { text } = reading;
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
      if (url !== "" && !DESCRIPTOR_LIKE.test(url.replaceAll(SUBST, "1"))) {
        shape = false;
        break;
      }
      url = text.slice(i + 1, end + 1);
    }
    spend(at - i);
    const start = i >= 0 ? (text[i] ?? "") : "";
    if (!shape) break;
    if (url === "") {
      if (start !== ",") break;
      at = i;
      continue;
    }
    if (!CANDIDATE_URL.test(url.replaceAll(SUBST, "x"))) break;
    if (start === ",") {
      at = i;
      continue;
    }
    answer = i < 0 || (QUOTES.has(start) && !isSpelled(reading, i) && opensValue(text, i));
    break;
  }
  for (const at of passed) known.set(at, answer);
  return answer;
}

/**
 * Whether a quote in a literal's text opens a value (an attribute's, a JSON key's or value's):
 * the character before it, past ASCII white space, is one VALUE_AFTER holds, or the text starts
 * there.
 * @param {string} text
 * @param {number} quote
 */
function opensValue(text, quote) {
  let k = quote - 1;
  while (k >= 0 && ASCII_SPACE.has(text[k] ?? "")) k--;
  spend(quote - k);
  return k < 0 || VALUE_AFTER.has(text[k] ?? "");
}

/**
 * How many values of a list of indexes, least first, stand before `at`.
 * @param {number[]} list
 * @param {number} at
 */
function countBefore(list, at) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] ?? Infinity) < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A web scheme's end without its start (`s` of `https`, `ttps`, `ss` of `wss`). */
const SCHEME_TAIL = /^(?:s|ps|tps|ttps|p|tp|ttp|ss)$/i;

/**
 * Whether a literal's text fixes a whole scheme before a colon (from the literal's start, after a
 * substitution, or after white space or punctuation): a letter, then letters, digits, `+`, `-` or
 * `.`, as the URL parser reads one (`git+https`, `chrome`, `mysql`). A scheme written at run time,
 * in part or whole, is none: after a substitution (`${p}s`), a placeholder's `%`, `{`, `$` or `)`
 * (`%s`, `$SCHEME`, `%(scheme)s`), or nothing at all (`{scheme}`, `"://"`); nor is a web scheme's
 * end at the literal's own start, whose start the code before it wrote (`p+"s://host"`,
 * `"http"+"s://host"`, `[p,"s://host"].join("")`).
 * @param {Reading} reading
 * @param {number} colon
 * @param {number} opener where the text the colon is in starts: -1, or a substitution's index
 */
function fixedScheme(reading, colon, opener) {
  const { text } = reading;
  let k = colon - 1;
  while (k > opener && /[A-Za-z0-9+.-]/.test(text[k] ?? "")) k--;
  spend(colon - k);
  const letters = text.slice(k + 1, colon);
  const placeholder = k >= 0 && (isSubst(reading, k) || "}%{$)".includes(text[k] ?? ""));
  if (!/^[A-Za-z]/.test(letters) || placeholder) return false;
  return !(k === opener && SCHEME_TAIL.test(letters));
}

/**
 * Two slashes at an index as the text wrote them: no reference or CSS escape spelled either.
 * @param {Reading} reading
 * @param {number} i
 */
const rawSlashes = (reading, i) => {
  for (const k of [i, i + 1]) {
    if (reading.text[k] !== "/" || isSpelled(reading, k)) return false;
  }
  return true;
};

/**
 * The URLs one reading of a text names: every http, https, ws or wss URL (its scheme in any case,
 * with slashes or backslashes or, where a literal starts, none), every protocol-relative one
 * (two or more slashes or backslashes) where a URL starts, every `://` in a literal's text after
 * a scheme written at run time, and every srcset candidate.
 * @param {Reading} reading
 * @param {Where} where
 * @param {Map<string, FoundUrl>} found
 */
function scanReading(reading, where, found) {
  const { text } = reading;
  const literal = where.kind === "literal";
  /** @param {FoundUrl | null} u */
  const keep = (u) => {
    if (u === null) return;
    const key = JSON.stringify(u);
    if (!found.has(key)) found.set(key, u);
  };
  /**
   * @param {string} scheme
   * @param {number} start
   * @param {UrlContext} context
   * @param {UrlStart} how
   */
  const read = (scheme, start, context, how) => {
    let reads = readAuthority(reading, start, context);
    // The hosts the code joins to a URL or chooses for it: after a scheme the text fixes or
    // writes at run time, and after two slashes where a URL starts, where a joined host counts
    // only where a browser reaches it on the network (`"//"+(a?"eslint-disable":"ts-ignore")`
    // names none).
    if (where.extend !== null && how !== "backslashes") reads = where.extend(reads, context, 0);
    for (const r of reads) {
      const authority = context.kind === "srcset" ? r.authority.replace(/,+$/, "") : r.authority;
      const network = context.network === true || (how === "slashes" && r.joined === true);
      keep(foundUrl(scheme, { ...r, authority }, how, network));
    }
  };
  /** The substitutions' indexes in the text, least first. */
  /** @type {number[] | null} */
  let substs = null;
  const substsOf = () => {
    if (substs === null) {
      substs = [];
      if (reading.subst !== null) {
        for (let k = 0; k < text.length; k++) if (isSubst(reading, k)) substs.push(k);
        spend(text.length);
      }
    }
    return substs;
  };
  /** @type {Map<number, boolean>} */
  const listEnds = new Map();
  /** @param {number} comma */
  const inList = (comma) => srcsetListBefore(reading, comma, listEnds);
  /** @param {number} start */
  const contexts = (start) => contextsBefore(reading, start, where, inList);
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
      // A scheme's slashes; or, in a literal, `://` after a scheme written at run time or not at
      // all (`` `${s}://host` ``, `s+"://host"`, `` `http${s?"s":""}://host` ``, `` `${p}s://host` ``,
      // `"{scheme}://host"`, `"%s://host"`), whose host is read as https: two slashes as the text
      // wrote them, and not after a scheme the text fixes, whose URL is that scheme's and loads no
      // web page (`git+https://`, `chrome://`, `socks5://`, `mysql://`).
      if (!literal || schemeColons.has(start - 1) || !rawSlashes(reading, start)) continue;
      const list = substsOf();
      const opener = list[countBefore(list, start - 1) - 1] ?? -1;
      if (fixedScheme(reading, start - 1, opener)) continue;
      /** @type {UrlContext} */
      const context =
        opener >= 0
          ? { kind: "quoted", end: "", spelled: false, guessed: true }
          : { kind: "quoted", end: "", spelled: false };
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
  /**
   * Every candidate of a srcset list from `from` to `end`.
   * @param {number} from
   * @param {number} end
   */
  const readList = (from, end) => {
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
  };
  /** @param {number} from */
  const unread = (from) => {
    keep({ url: `srcset@${from}`, origin: null, userinfo: false, unread: true, unparsed: false });
  };
  if (where.keyed) {
    // A list a key in the code names: the literal is the list, whatever it holds. A template
    // literal's list that spans more source than MAX_SRCSET is refused whole (url-unread).
    if (where.template && where.span > MAX_SRCSET) unread(0);
    else readList(0, text.length);
  }
  for (const m of text.matchAll(literal ? LITERAL_SRCSET : SRCSET)) {
    const separator = m[1] ?? "";
    const open = m[2] ?? "";
    const from = (m.index ?? 0) + m[0].length;
    let close = -1;
    if (open === "") {
      // An unquoted value, in markup or in a start tag a script writes: it ends at white space or
      // `>` as written, not at one a reference spells.
      if (separator !== "=" || where.kind === "style") continue;
      if (literal && !where.inTag((m.index ?? 0) + m[0].lastIndexOf("="))) continue;
      close = from;
      while (close < text.length && close - from <= MAX_SRCSET) {
        const c = text[close] ?? "";
        if ((ASCII_SPACE.has(c) || c === ">") && !isSpelled(reading, close)) break;
        close++;
      }
      spend(close - from);
      if (close - from > MAX_SRCSET) close = -1;
    } else {
      const spelled = isSpelled(reading, from - 1);
      close = text.indexOf(open, from);
      while (close !== -1 && isSpelled(reading, close) !== spelled) {
        close = text.indexOf(open, close + 1);
      }
      spend((close === -1 ? text.length : close) - from);
      // In a literal, a list its text does not close ends with the literal: the code goes on.
      if (close === -1 && literal) close = text.length;
    }
    const end = close === -1 ? Math.min(text.length, from + MAX_SRCSET) : close;
    if (end < text.length && close === -1) {
      // Refused whole (url-unread), so its candidates are not read: each list read is one that
      // closes within the bound, and lists that run on past it cost no more than finding so.
      unread(from);
      continue;
    }
    readList(from, end);
  }
}

// ---- a script's tokens -------------------------------------------------------------------------

/**
 * A script read through the tokenizer: its tokens; the significant ones (comments aside, `sig`);
 * the place each opening bracket closes at (`closer`, a template literal's head, middles and tail
 * paired too); and its literals, each string and each template literal whole, with their pieces
 * in source order.
 * @typedef {object} Script
 * @property {Token[]} tokens
 * @property {number[]} sig
 * @property {Int32Array} closer
 * @property {Literal[]} literals
 * @property {Piece[]} pieces
 * @property {Map<number, Literal>} startsAt the literal each significant place starts
 */
/**
 * A literal: a string, or a template literal with its pieces. `first` and `last` are its first and
 * last tokens' significant places; `subs`, each substitution's code as a range of places;
 * `readings`, its readings by name (readingOf), and `marks`, where each substitution stands in
 * each of them.
 * @typedef {object} Literal
 * @property {number} first
 * @property {number} last
 * @property {Piece[]} pieces
 * @property {Array<[number, number]>} subs
 * @property {boolean} template
 * @property {boolean} tagged
 * @property {Map<string, Reading> | null} readings
 * @property {Map<string, number[]> | null} marks
 */
/**
 * A piece of a literal: its token's significant place, its literal, which piece of it it is,
 * where the last `;` of its own statement level or an outer one stands in the source before it
 * (`boundary`, -1 for none): code before it is another statement's; and, for a literal's first
 * piece, whether it goes on with a string an earlier statement began (`cross`): it stands after
 * `+` or `+=`, in a statement whose own `+=` stands before it, at a substitution's start, as a
 * `.concat(` call's argument, or it is a template literal's head that starts with a substitution.
 * @typedef {{ place: number, literal: Literal, n: number, boundary: number, cross: boolean }} Piece
 */

const LITERAL = new Set([
  "string",
  "template",
  "template-head",
  "template-middle",
  "template-tail",
]);
const COMMENT = new Set(["hashbang", "line-comment", "block-comment"]);
/** Words after which a template literal is an operand, not a tagged one's. */
const OPERAND_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "extends",
  "default",
  "export",
]);

/**
 * A literal with no pieces yet.
 * @param {number} first
 * @param {boolean} template
 * @param {boolean} tagged
 * @returns {Literal}
 */
const newLiteral = (first, template, tagged) => ({
  first,
  last: first,
  pieces: [],
  subs: [],
  template,
  tagged,
  readings: null,
  marks: null,
});

/**
 * A script's model from its tokens.
 * @param {Token[]} tokens
 * @returns {Script}
 */
function scriptOf(tokens) {
  /** @type {number[]} */
  const sig = [];
  tokens.forEach((t, i) => {
    if (!COMMENT.has(t.kind)) sig.push(i);
  });
  const closer = new Int32Array(sig.length).fill(-1);
  /** @type {number[]} */
  const open = [];
  /** @type {Literal[]} */
  const literals = [];
  /** @type {Piece[]} */
  const pieces = [];
  /** @type {Literal[]} */
  const templates = [];
  /** @type {Map<number, Literal>} */
  const startsAt = new Map();
  /** @param {number} p */
  const tokenAt = (p) => /** @type {Token} */ (tokens[sig[p] ?? -1]);
  /** @param {number} p */
  const taggedAt = (p) => {
    const before = p > 0 ? tokenAt(p - 1) : undefined;
    if (before === undefined) return false;
    if (before.kind === "name") return !OPERAND_WORDS.has(before.value);
    if (before.kind === "punct") return before.value === ")" || before.value === "]";
    return before.kind === "template" || before.kind === "template-tail";
  };
  // The last `;` of each open bracket's level or an outer one, by depth (open.length): a level
  // inherits its outer level's when it opens, and a `;` is the latest of its own. So is the last
  // `+=`: a statement whose own `+=` stands after its `;` is one.
  /** @type {number[]} */
  const semicolon = [-1];
  /** @type {number[]} */
  const plusAssign = [-1];
  // Whether each open bracket is a `.concat(` call's parenthesis, by depth.
  /** @type {boolean[]} */
  const concat = [false];
  /** @param {Literal} lit @param {number} p */
  const addPiece = (lit, p) => {
    const depth = open.length;
    const boundary = semicolon[depth] ?? -1;
    let cross = false;
    if (lit.pieces.length === 0) {
      const t = tokenAt(p);
      const before = p > 0 ? tokenAt(p - 1) : undefined;
      cross =
        (plusAssign[depth] ?? -1) > boundary ||
        (t.kind === "template-head" && t.raw === "") ||
        before?.kind === "template-head" ||
        before?.kind === "template-middle" ||
        (before?.kind === "punct" &&
          (before.value === "+" ||
            before.value === "+=" ||
            (concat[depth] === true && (before.value === "(" || before.value === ","))));
    }
    const piece = { place: p, literal: lit, n: lit.pieces.length, boundary, cross };
    lit.pieces.push(piece);
    pieces.push(piece);
  };
  /** @param {number} p */
  const push = (p) => {
    open.push(p);
    const depth = open.length;
    semicolon[depth] = semicolon[depth - 1] ?? -1;
    plusAssign[depth] = plusAssign[depth - 1] ?? -1;
    const t = tokenAt(p);
    const callee = p > 0 ? tokenAt(p - 1) : undefined;
    const dot = p > 1 ? tokenAt(p - 2) : undefined;
    concat[depth] =
      t.kind === "punct" &&
      t.value === "(" &&
      callee?.kind === "name" &&
      callee.value === "concat" &&
      dot?.kind === "punct" &&
      (dot.value === "." || dot.value === "?.");
  };
  for (let p = 0; p < sig.length; p++) {
    const t = tokenAt(p);
    if (t.kind === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{") push(p);
      else if (t.value === ")" || t.value === "]" || t.value === "}") {
        const o = open.pop();
        if (o !== undefined) closer[o] = p;
      } else if (t.value === ";") {
        semicolon[open.length] = t.start;
      } else if (t.value === "+=") {
        plusAssign[open.length] = t.start;
      }
    } else if (t.kind === "string" || t.kind === "template") {
      const lit = newLiteral(p, t.kind === "template", t.kind === "template" && taggedAt(p));
      addPiece(lit, p);
      literals.push(lit);
      startsAt.set(p, lit);
    } else if (t.kind === "template-head") {
      const lit = newLiteral(p, true, taggedAt(p));
      addPiece(lit, p);
      literals.push(lit);
      startsAt.set(p, lit);
      templates.push(lit);
      push(p);
    } else if (t.kind === "template-middle" || t.kind === "template-tail") {
      // The tokenizer refuses a script whose brackets do not pair, so each closes what is open.
      const lit = /** @type {Literal} */ (templates.at(-1));
      const o = /** @type {number} */ (open.pop());
      lit.subs.push([o + 1, p]);
      closer[o] = p;
      addPiece(lit, p);
      if (t.kind === "template-tail") {
        lit.last = p;
        templates.pop();
      } else {
        push(p);
      }
    }
  }
  spend(tokens.length + sig.length);
  return { tokens, sig, closer, literals, pieces, startsAt };
}

/**
 * The token at a significant place, if any.
 * @param {Script} script
 * @param {number} p
 */
const tokenAt = (script, p) => script.tokens[script.sig[p] ?? -1];

/**
 * A literal's text, its substitutions marked: the pieces' cooked values, or (`raw`) their text as
 * written, joined by SUBST.
 * @param {Script} script
 * @param {Literal} lit
 * @param {boolean} raw
 * @returns {Reading}
 */
function literalText(script, lit, raw) {
  const parts = lit.pieces.map((piece) => {
    const t = /** @type {Token} */ (tokenAt(script, piece.place));
    return raw ? (t.raw ?? t.value) : t.value;
  });
  const text = parts.join(SUBST);
  if (parts.length === 1) return { text, spelled: null, subst: null };
  const subst = new Uint8Array(text.length);
  let at = 0;
  for (const part of parts.slice(0, -1)) {
    at += part.length;
    subst[at] = 1;
    at += 1;
  }
  return { text, spelled: null, subst };
}

/**
 * The names of a literal's readings, each read the same way for every literal: its text as it
 * stands, through HTML's references, CSS's escapes, and both; and a tagged template's raw text so
 * too, which its tag reads.
 */
const READINGS = ["value", "html", "css", "css-html"];
const RAW_READINGS = ["raw", "raw-html", "raw-css", "raw-css-html"];

/**
 * A reading's name for a literal: a raw reading only for a tagged template literal.
 * @param {Literal} lit
 * @param {string} name
 */
const nameFor = (lit, name) => (lit.tagged ? name : name.replace(/^raw-?/, "") || "value");

/**
 * One named reading of a literal, made once.
 * @param {Script} script
 * @param {Literal} lit
 * @param {string} name a READINGS or RAW_READINGS name
 * @returns {Reading}
 */
function readingOf(script, lit, name) {
  const cached = lit.readings?.get(name);
  if (cached !== undefined) return cached;
  const raw = name.startsWith("raw");
  const kind = name.replace(/^raw-?/, "") || "value";
  /** @type {Reading} */
  let reading;
  if (kind === "value") reading = literalText(script, lit, raw);
  else if (kind === "html")
    reading = readHtmlReferences(readingOf(script, lit, raw ? "raw" : "value"));
  else if (kind === "css") reading = readCssEscapes(readingOf(script, lit, raw ? "raw" : "value"));
  else reading = readCssEscapes(readingOf(script, lit, raw ? "raw-html" : "html"));
  lit.readings ??= new Map();
  lit.readings.set(name, reading);
  return reading;
}

/**
 * Where each substitution stands in a literal's named reading, least first, found once.
 * @param {Script} script
 * @param {Literal} lit
 * @param {string} name
 * @returns {number[]}
 */
function marksOf(script, lit, name) {
  const cached = lit.marks?.get(name);
  if (cached !== undefined) return cached;
  const reading = readingOf(script, lit, name);
  /** @type {number[]} */
  const marks = [];
  if (reading.subst !== null) {
    for (let k = 0; k < reading.text.length; k++) if (isSubst(reading, k)) marks.push(k);
    spend(reading.text.length);
  }
  lit.marks ??= new Map();
  lit.marks.set(name, marks);
  return marks;
}

// The HTML tokenizer's states inside a start tag, as bits, so every tag open at once is followed
// in one pass: before an attribute's name, in it, after it, before its value, in a double- or
// single-quoted value, in an unquoted one, after a quoted one; and, before them, a `<` just read
// and a tag's name.
const BEFORE_NAME = 1;
const NAME = 2;
const AFTER_NAME = 4;
const BEFORE_VALUE = 8;
const DOUBLE = 16;
const SINGLE = 32;
const UNQUOTED = 64;
const AFTER_QUOTED = 128;
const LESS = 256;
const TAG_NAME = 512;
/** How far apart, in characters of code, two literals may stand for a tag to go on in the next. */
const MAX_PIECE_GAP = 1024;

/**
 * One tokenizer state's next states on a character, as bits (0 when the tag ends at `>`). A
 * character a reference spelled is data (`data`): the tokenizer reads the reference as text.
 * @param {number} state
 * @param {string} c
 * @param {boolean} data
 */
function nextTagState(state, c, data) {
  const space = !data && (c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ");
  const double = !data && c === '"';
  const single = !data && c === "'";
  if (state === DOUBLE) return double ? AFTER_QUOTED : DOUBLE;
  if (state === SINGLE) return single ? AFTER_QUOTED : SINGLE;
  if (!data && c === ">") return 0;
  if (state === LESS) return !data && /[A-Za-z]/.test(c) ? TAG_NAME : 0;
  if (state === TAG_NAME) {
    if (space || (!data && c === "/")) return BEFORE_NAME;
    return !data && /[A-Za-z0-9-]/.test(c) ? TAG_NAME : 0;
  }
  if (state === UNQUOTED) return space ? BEFORE_NAME : UNQUOTED;
  if (state === BEFORE_VALUE) {
    if (space) return BEFORE_VALUE;
    return double ? DOUBLE : single ? SINGLE : UNQUOTED;
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
 * A start tag's states after one character, every state in a set stepped at once; a raw `<` may
 * open a tag wherever it stands.
 * @param {number} states
 * @param {string} c
 * @param {boolean} data
 */
function stepTag(states, c, data) {
  let after = 0;
  for (let bit = 1; bit <= TAG_NAME; bit <<= 1) {
    if ((states & bit) !== 0) after |= nextTagState(bit, c, data);
  }
  if (!data && c === "<") after |= LESS;
  return after;
}

/**
 * A start tag's states after code that writes text at run time (a substitution, or the code
 * between two literals): those before it (it may write nothing), a name's (it may write one), a
 * new attribute's (it may end a value: `"`, `" `), and an unquoted value's after `=` (it may write
 * one). A `<` or a tag's name before it opens a tag the code goes on with (`"<"+t`, `<a${c}`).
 * @param {number} live
 */
function afterSubstitution(live) {
  if (live === 0) return 0;
  let after = (live & ~(LESS | TAG_NAME)) | NAME;
  if ((live & (LESS | TAG_NAME)) !== 0) after |= BEFORE_NAME;
  if ((live & (DOUBLE | SINGLE | UNQUOTED)) !== 0) after |= AFTER_QUOTED | BEFORE_NAME;
  if ((live & BEFORE_VALUE) !== 0) after |= UNQUOTED;
  return after;
}

/**
 * One piece of a literal's text, as the tag pass reads it: its literal, the reading and the range
 * of it the piece holds, where the piece stands in the source, which piece of its literal it is
 * (`n`), whether the literal goes on after it (`more`: a substitution follows), and, for a
 * literal's first piece, whether the code joins it to an earlier literal (`joined`), whether it
 * goes on with a string an earlier statement began (Piece's `cross`), and where its statement
 * starts (Piece's `boundary`).
 * @typedef {{ literal: object, reading: Reading, from: number, to: number, start: number,
 *   end: number, n: number, more: boolean, joined: boolean, cross: boolean,
 *   boundary: number }} TagPiece
 */

/** What may stand before a literal that goes on with markup an earlier literal began. */
const JOINS = new Set(["+", "+=", ",", "(", "[", "?", ":", "&&", "||", "??"]);

/**
 * The `=` signs in a sequence of literal pieces that give an attribute its value in some start
 * tag, each tag read as an HTML tokenizer reads it, through every piece in source order (the
 * markup a script writes: `e.outerHTML='<img src=//host/p.png>'`). Every tag open at a point is
 * followed at once (a tag inside another's quoted value included), so the pass is linear. A
 * character a reference spelled is data (`&gt;` ends no tag). Where the script's code stands
 * between two pieces, it may write any text (afterSubstitution):
 * - a template literal's substitution: the states held where it starts go on where it ends, after
 *   the code and any literal nested in it (whose own states go on there too), whatever its length;
 * - code between two literals: the states at a literal's end are held, up to MAX_PIECE_GAP
 *   characters after it, and go on in each later literal the code joins to them (after `+`, `+=`,
 *   a list's or a call's comma or bracket, a condition's branches, `&&`, `||`, `??`, at a
 *   substitution's start, or as a template literal that starts with one), a condition's branches
 *   each holding theirs; across a statement's end (a `;` of the later literal's level or an outer
 *   one) only where the later statement goes on with a string an earlier one began, as a
 *   variable holds it (Piece's `cross`: `let h="<a ";h+=" href=..."`, `h+=t+" href=..."`,
 *   `const n="<a "+t;e.innerHTML=n+" href=..."`, `n.concat(" href=...")`, `` `${n} href=...` ``).
 * A `<` or a tag's name at a piece's end opens a tag the code goes on with (`"<"+t+" href=..."`,
 * `` `<a${c} href=...>` ``, `` `<${t} href=...>` ``). The code itself is never read as text.
 * @param {Iterable<TagPiece>} pieces
 * @returns {Map<object, Set<number>>}
 */
function tagPass(pieces) {
  /** @type {Map<object, Set<number>>} */
  const equals = new Map();
  // The states held at literals' ends, until when, and the end of the piece that last held some.
  let held = 0;
  let heldUntil = -1;
  let heldAt = -1;
  /** The states each literal held where its last substitution starts, and where that is. */
  /** @type {Map<object, { states: number, at: number }>} */
  const atSubstitution = new Map();
  for (const piece of pieces) {
    const { literal, reading, from, to } = piece;
    const { text } = reading;
    let states = 0;
    if (piece.n === 0) {
      const sameStatement = piece.cross || piece.boundary < heldAt;
      if (held !== 0 && heldUntil >= piece.start && piece.joined && sameStatement) {
        states = afterSubstitution(held);
      }
    } else {
      const sub = atSubstitution.get(literal);
      if (sub !== undefined) {
        states = afterSubstitution(sub.states);
        // A literal nested in the substitution held states it may write.
        if (held !== 0 && heldAt > sub.at && heldUntil >= piece.start) {
          states |= afterSubstitution(held);
        }
      }
    }
    if (states === 0 && text.indexOf("<", from) === -1) {
      spend(to - from);
    } else {
      for (let i = from; i < to; i++) {
        const c = text[i] ?? "";
        const data = isSpelled(reading, i);
        if (c === "=" && !data && (states & (NAME | AFTER_NAME)) !== 0) {
          const set = equals.get(literal) ?? new Set();
          set.add(i);
          equals.set(literal, set);
        }
        states = stepTag(states, c, data);
      }
      spend(to - from);
    }
    if (piece.more) atSubstitution.set(literal, { states, at: piece.end });
    if (states !== 0) {
      held = (heldUntil < piece.end ? 0 : held) | states;
      heldUntil = piece.end + MAX_PIECE_GAP;
      heldAt = piece.end;
    }
  }
  return equals;
}

/**
 * A script's literal pieces in source order, in one named reading each, as the tag pass reads
 * them.
 * @param {Script} script
 * @param {string} name
 * @returns {Generator<TagPiece>}
 */
function* scriptPieces(script, name) {
  for (const piece of script.pieces) {
    const lit = piece.literal;
    const token = /** @type {Token} */ (tokenAt(script, piece.place));
    const readingName = nameFor(lit, name);
    const reading = readingOf(script, lit, readingName);
    const marks = marksOf(script, lit, readingName);
    const from = piece.n === 0 ? 0 : (marks[piece.n - 1] ?? reading.text.length - 1) + 1;
    const to = marks[piece.n] ?? reading.text.length;
    const before = piece.n === 0 ? tokenAt(script, piece.place - 1) : undefined;
    // A template literal that starts with a substitution: the code there may write any text, a
    // string an earlier literal began included (`` `${n} href=...` ``).
    const leads = piece.n === 0 && token.kind === "template-head" && token.raw === "";
    const joined =
      leads ||
      (before !== undefined &&
        ((before.kind === "punct" && JOINS.has(before.value)) ||
          before.kind === "template-head" ||
          before.kind === "template-middle"));
    yield {
      literal: lit,
      reading,
      from,
      to: Math.max(from, to),
      start: token.start,
      end: token.end,
      n: piece.n,
      more: piece.n < lit.pieces.length - 1,
      joined,
      cross: piece.cross,
      boundary: piece.boundary,
    };
  }
}

/** Bounds on the joins: how many literals one after another, and how many hosts chosen. */
const MAX_JOINS = 4;
const MAX_CHOICES = 64;

/**
 * The texts the tokens of an expression (significant places `from` to `to`, a substitution's or
 * brackets') choose its value from, each as the URL parser reads a literal's text (tabs and new
 * lines dropped), or null where it may take any other value: a literal, alone, in brackets, as a
 * condition's branch (`c?"a":"b"`, nested; the condition any expression, one that starts with a
 * literal included), after `||` or `??` (`"a"||"b"`), or literals joined by `+`, each pair of
 * choices joined (`(c?"app":"staging")+".host"`), at most MAX_CHOICES. A value that is a name, a
 * call, a template literal with a substitution or anything else, or joins one, is one built at
 * run time.
 * @param {Script} script
 * @param {number} from
 * @param {number} to
 * @param {string} name the reading's name, whose decoding each literal's text gets
 * @returns {string[] | null}
 */
function literalChoice(script, from, to, name) {
  const { tokens, sig, closer } = script;
  /** @param {number} p */
  const at = (p) => (p < to ? tokens[sig[p] ?? -1] : undefined);
  /** @param {number} p @param {string} v */
  const punct = (p, v) => {
    const t = at(p);
    return t !== undefined && t.kind === "punct" && t.value === v;
  };
  const kind = name.replace(/^raw-?/, "") || "value";
  /** @param {Token} t */
  const textOf = (t) => {
    /** @type {Reading} */
    let r = { text: t.value, spelled: null, subst: null };
    if (kind === "html" || kind === "css-html") r = readHtmlReferences(r);
    if (kind === "css" || kind === "css-html") r = readCssEscapes(r);
    return r.text.replace(/[\t\n\r]/g, "");
  };
  /**
   * The place of a condition's top-level `?` from `p`, or -1.
   * @param {number} p
   */
  const conditionEnd = (p) => {
    for (let k = p; k < to; k++) {
      spend(1);
      const t = /** @type {Token} */ (at(k));
      const close = closer[k] ?? -1;
      if (close > k) {
        k = close;
        continue;
      }
      if (t.kind !== "punct") continue;
      if (t.value === "?") return k;
      if ([":", ",", ";", ")", "]", "}"].includes(t.value)) return -1;
    }
    return -1;
  };
  /** @typedef {{ values: string[], end: number }} Chosen */
  /**
   * A literal, or a value in brackets.
   * @param {number} p
   * @param {number} depth
   * @returns {Chosen | null}
   */
  const primary = (p, depth) => {
    if (depth > 8) return null;
    const t = at(p);
    if (t === undefined) return null;
    if (t.kind === "string" || t.kind === "template") return { values: [textOf(t)], end: p + 1 };
    if (!punct(p, "(")) return null;
    const inner = value(p + 1, depth + 1);
    if (inner === null || !punct(inner.end, ")")) return null;
    return { values: inner.values, end: inner.end + 1 };
  };
  /** @param {number} e */
  const goesOn = (e) =>
    e >= to || punct(e, "+") || punct(e, "||") || punct(e, "??") || punct(e, ":") || punct(e, ")");
  /**
   * @param {number} p
   * @param {number} depth
   * @returns {Chosen | null}
   */
  const value = (p, depth) => {
    if (depth > 8) return null;
    let r = primary(p, depth);
    if (r === null || !goesOn(r.end)) {
      const mark = conditionEnd(p);
      const yes = mark === -1 ? null : value(mark + 1, depth + 1);
      if (yes === null || !punct(yes.end, ":")) return null;
      const no = value(yes.end + 1, depth + 1);
      if (no === null) return null;
      r = { values: [...yes.values, ...no.values], end: no.end };
    }
    for (;;) {
      /** @type {string[]} */
      let values;
      if (punct(r.end, "+")) {
        // `+` joins tighter than `||`, `??` and a condition: only the literal or brackets after it.
        const more = primary(r.end + 1, depth + 1);
        if (more === null) return null;
        if (r.values.length * more.values.length > MAX_CHOICES) return null;
        spend(r.values.length * more.values.length);
        const left = r.values;
        values = left.flatMap((a) => more.values.map((b) => a + b));
        r = { values, end: more.end };
      } else if (punct(r.end, "||") || punct(r.end, "??")) {
        const more = value(r.end + 1, depth + 1);
        if (more === null) return null;
        values = [...r.values, ...more.values];
        r = { values, end: more.end };
      } else {
        return r;
      }
      if (values.length > MAX_CHOICES) return null;
    }
  };
  const r = value(from, 0);
  return r !== null && r.end === to ? r.values : null;
}

/** What a join goes on with where the host is built at run time, and where it ends. */
/** @type {AuthorityRead} */
const RUN_TIME = { authority: "", cut: false, crossed: true, built: true };
/** @type {AuthorityRead} */
const ENDS = { authority: "", cut: false, crossed: true, built: false };

/**
 * Each chosen literal as a host's text: up to its first `/`, `\`, `?` or `#`, or, where it names
 * none, joined to each authority the text after the choice goes on with, at most MAX_CHOICES.
 * @param {string[]} values
 * @param {() => AuthorityRead[]} after
 * @returns {AuthorityRead[]}
 */
function choose(values, after) {
  /** @type {AuthorityRead[]} */
  const out = [];
  /** @type {AuthorityRead[] | null} */
  let rests = null;
  for (const value of values) {
    const cut = value.search(/[/\\?#]/);
    if (cut !== -1) {
      out.push({ authority: value.slice(0, cut), cut: false, crossed: true, built: false });
    } else {
      rests ??= after();
      for (const rest of rests) {
        out.push({
          authority: value + rest.authority,
          cut: rest.cut,
          crossed: true,
          built: rest.built,
        });
        if (out.length >= MAX_CHOICES) break;
      }
    }
    spend(1);
    if (out.length >= MAX_CHOICES) break;
  }
  return out;
}

/**
 * A literal's reads of a URL's authority, with the hosts the code joins to them from literals
 * (`"https://"+"host/x"`, `"https://ho"+"st/x"`, in markup a literal holds:
 * `'<a href="https://'+"host"+'">'`) or chooses among literals in a substitution or brackets
 * (`` `https://${p?`app.host`:`staging.host`}/x` ``, `` `https://`+(p?`a.host`:`b.host`) ``,
 * `` `https://${(p?`app`:`staging`)+`.host`}` ``), read past the literal's end (`crossed`). A read
 * the code goes on from is a host's start (`built`): a single label there, or one with only a dot
 * after it, is a host built at run time (foundUrl), whether a name, a call or a literal goes on
 * with it (`"https://www."+host`, `` `https://${p?"":"staging."}${zone}` ``). A plain identifier,
 * a call or anything else joined or chosen is a host built at run time: the page's own policy
 * refuses it. Joins are followed up to MAX_JOINS deep.
 * @param {Script} script
 * @param {Literal} lit
 * @param {string} name the reading's name
 * @param {AuthorityRead[]} reads
 * @param {UrlContext} context
 * @param {number} depth
 * @returns {AuthorityRead[]}
 */
function extendReads(script, lit, name, reads, context, depth) {
  const reading = readingOf(script, lit, name);
  /** @type {AuthorityRead[]} */
  const out = [];
  for (const r of reads) {
    const at = r.end ?? -1;
    /** @type {AuthorityRead[] | null} */
    let rests = null;
    if (!r.cut && at >= 0) {
      if (at < reading.text.length && isSubst(reading, at)) {
        rests = chosenAt(script, lit, name, at, context, depth);
      } else if (at === reading.text.length) {
        rests = joinedAfter(script, lit.last, name, context, depth, r.authority === "");
      }
    }
    if (rests === null) {
      out.push(r);
      continue;
    }
    out.push({ ...r, built: true });
    // A substitution read past before the join stays in the host: it is built at run time.
    const inside = r.built && r.authority.includes("${");
    for (const rest of rests) {
      out.push({
        authority: r.authority + rest.authority,
        cut: rest.cut,
        crossed: true,
        built: rest.built || inside,
        joined: true,
      });
    }
  }
  return out;
}

/**
 * What a choice among literals in a substitution gives the host, each literal joined to what the
 * text after the substitution goes on with (`` `https://${p?`app.host`:`staging.host`}/x` ``,
 * `` `https://${p?"":"staging."}host` ``), or null where the substitution may hold anything else.
 * @param {Script} script
 * @param {Literal} lit
 * @param {string} name
 * @param {number} at the substitution's index in the literal's reading
 * @param {UrlContext} context
 * @param {number} depth
 * @returns {AuthorityRead[] | null}
 */
function chosenAt(script, lit, name, at, context, depth) {
  if (depth >= MAX_JOINS) return null;
  const reading = readingOf(script, lit, name);
  const range = lit.subs[countBefore(marksOf(script, lit, name), at)];
  if (range === undefined) return null;
  const values = literalChoice(script, range[0], range[1], name);
  if (values === null) return null;
  return choose(values, () =>
    extendReads(script, lit, name, readAuthority(reading, at + 1, context), context, depth + 1),
  );
}

/**
 * What the code joins with `+` after the significant place `place` (a literal's last token, or a
 * bracket's close): null where nothing is joined; the next literal's authority (past the URL's
 * slashes, where none is read yet: `"https:/"+"/host"`), or each literal a choice in brackets gives
 * (`` `https://`+(p?`a.host`:`b.host`) ``), each going on with its own joins; a host built at run
 * time where a name, a call or anything else is joined, or the joins pass MAX_JOINS. The next
 * literal ends the URL where the URL's own context does, and at its own end.
 * @param {Script} script
 * @param {number} place
 * @param {string} name
 * @param {UrlContext} context
 * @param {number} depth
 * @param {boolean} slashes whether the URL's slashes may go on in the next literal
 * @returns {AuthorityRead[] | null}
 */
function joinedAfter(script, place, name, context, depth, slashes) {
  if (!punctAt(script, place + 1, "+")) return null;
  if (depth >= MAX_JOINS) return [RUN_TIME];
  const k = place + 2;
  const next = script.startsAt.get(k);
  if (next !== undefined) {
    const nextName = nameFor(next, name);
    const reading = readingOf(script, next, nextName);
    let from = 0;
    if (slashes) {
      SLASH_RUN.lastIndex = 0;
      from += SLASH_RUN.exec(reading.text)?.[0].length ?? 0;
    }
    /** @type {UrlContext} */
    const within =
      context.kind === "srcset" ? { kind: "quoted", end: "", spelled: false } : context;
    const reads = readAuthority(reading, from, within);
    return extendReads(script, next, nextName, reads, within, depth + 1).map((r) => ({
      ...r,
      crossed: true,
    }));
  }
  if (!punctAt(script, k, "(")) return [RUN_TIME];
  const close = script.closer[k] ?? -1;
  if (close < 0) return [RUN_TIME];
  const values = literalChoice(script, k + 1, close, name);
  if (values === null) return [RUN_TIME];
  return choose(
    values,
    () => joinedAfter(script, close, name, context, depth + 1, false) ?? [ENDS],
  );
}

/**
 * Whether a token at a significant place has the punctuator `v`.
 * @param {Script} script
 * @param {number} p
 * @param {string} v
 */
const punctAt = (script, p, v) => {
  const t = tokenAt(script, p);
  return t !== undefined && t.kind === "punct" && t.value === v;
};

/**
 * Whether the token at a significant place is a name, or a literal with no substitution, whose
 * text, lower-cased, a test accepts.
 * @param {Script} script
 * @param {number} p
 * @param {(lower: string) => boolean} test
 */
const keyAt = (script, p, test) => {
  const t = tokenAt(script, p);
  if (t === undefined) return false;
  if (t.kind !== "name" && t.kind !== "string" && t.kind !== "template") return false;
  return test(t.value.toLowerCase());
};

/**
 * An attribute's name that names a srcset list, lower-cased (`srcset`, `imagesrcset`,
 * `data-srcset`): a call's later argument that is exactly one is a key. Prose that names one
 * (`"Invalid srcset:"`) is none.
 */
const SRCSET_NAME = /^[a-z-]*srcset$/;

/**
 * The literals a key in the code names a srcset list: the value after `srcSet:`, `.srcset=`,
 * `"srcset":`, `i["srcset"]=`, `setAttribute("srcset",` and a call's later argument that is
 * exactly an attribute's name (`attr(e,"srcset",`, `setAttributeNS(null,"srcset",`) (a key whose
 * name ends in srcset: `imageSrcSet` too), and every literal in that value up to its end (a `,`,
 * `;` or closing bracket of its own level: `srcSet:d?"/a.png, //host/b.png 2x":"/l.png"`,
 * `srcSet:p??"..."`). A value that holds another such key ends there, so the work stays linear.
 * @param {Script} script
 * @returns {Set<Literal>}
 */
function srcsetValues(script) {
  /** @type {Set<Literal>} */
  const keyed = new Set();
  /** @param {string} lower */
  const srcset = (lower) => lower.endsWith("srcset");
  /**
   * The place where the value a key at `p` is given starts, or -1.
   * @param {number} p
   */
  const valueAfter = (p) => {
    if (!keyAt(script, p, srcset)) return -1;
    if (punctAt(script, p + 1, ":") || punctAt(script, p + 1, "=")) return p + 2;
    // `i["srcset"]=`
    if (punctAt(script, p - 1, "[") && punctAt(script, p + 1, "]") && punctAt(script, p + 2, "=")) {
      return p + 3;
    }
    // `setAttribute("srcset",`, and a later argument that is exactly an attribute's name, as a
    // helper that takes the element or a namespace first names it (`attr(e,"srcset",`,
    // `setAttribute(e,"srcset",`, `setAttributeNS(null,"srcset",`).
    if (tokenAt(script, p)?.kind !== "name" && punctAt(script, p + 1, ",")) {
      if (punctAt(script, p - 1, "(")) return p + 2;
      if (punctAt(script, p - 1, ",") && keyAt(script, p, (lower) => SRCSET_NAME.test(lower))) {
        return p + 2;
      }
    }
    return -1;
  };
  for (let p = 0; p < script.sig.length; p++) {
    const from = valueAfter(p);
    if (from < 0) continue;
    let depth = 0;
    let k = from;
    for (; k < script.sig.length; k++) {
      const t = /** @type {Token} */ (tokenAt(script, k));
      if (k > from && valueAfter(k) >= 0) break;
      const lit = script.startsAt.get(k);
      if (lit !== undefined) keyed.add(lit);
      if (t.kind === "template-head") depth++;
      else if (t.kind === "template-tail") depth--;
      else if (t.kind === "punct") {
        if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
        else if (t.value === ")" || t.value === "]" || t.value === "}") {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (t.value === "," || t.value === ";")) break;
      }
    }
    spend(k - from + 1);
    p = Math.max(p, k - 1);
  }
  return keyed;
}

/** http-equiv's refresh, in markup a literal holds. */
const HTTP_EQUIV_REFRESH = /http-equiv[ \t\n\f\r]*=[ \t\n\f\r]*["']?refresh(?![\w$-])/i;

/**
 * Where a refresh key stands, as offsets in the source, least first: http-equiv's refresh
 * (`httpEquiv:"refresh"`, `m.httpEquiv="refresh"`, `setAttribute("http-equiv","refresh")`,
 * `"http-equiv":"refresh"`, `http-equiv=refresh` in markup a literal holds), or `refresh` as a
 * property's name (`{refresh:...}`, `{"refresh":...}`, `o.refresh=...`). Never a longer name
 * (`refreshToken`, `"refresh_token"`, `onRefresh`, `$RefreshReg$`), a function's or a call's
 * (`function refresh`, `refresh()`), a variable's (`let refresh`), nor the word as any other value
 * (a label's `"Refresh"`, an event's or an action's `"refresh"`).
 * @param {Script} script
 * @returns {number[]}
 */
function refreshKeys(script) {
  /** @type {number[]} */
  const keys = [];
  /** @param {string} lower */
  const equiv = (lower) => lower === "httpequiv" || lower === "http-equiv";
  /** @param {string} lower */
  const refresh = (lower) => lower === "refresh";
  for (let p = 0; p < script.sig.length; p++) {
    const t = /** @type {Token} */ (tokenAt(script, p));
    if (LITERAL.has(t.kind)) {
      const value =
        (t.kind === "string" || t.kind === "template") &&
        refresh(t.value.toLowerCase()) &&
        (punctAt(script, p - 1, ":") ||
          punctAt(script, p - 1, "=") ||
          punctAt(script, p - 1, ",")) &&
        keyAt(script, p - 2, equiv);
      if (value || HTTP_EQUIV_REFRESH.test(t.value)) {
        keys.push(t.start);
        continue;
      }
    }
    if ((t.kind === "name" || t.kind === "string") && refresh(t.value.toLowerCase())) {
      const property =
        (punctAt(script, p + 1, ":") &&
          (punctAt(script, p - 1, "{") || punctAt(script, p - 1, ","))) ||
        (t.kind === "name" && punctAt(script, p - 1, ".") && punctAt(script, p + 1, "="));
      if (property) keys.push(t.start);
    }
  }
  spend(script.sig.length);
  return keys;
}

/** Characters without which no reading of a literal's text holds a URL's start. */
const URL_SIGNS = /[:/\\&]/;

/**
 * The URLs a script's literals name, each literal read in each of its readings.
 * @param {Script} script
 * @param {Map<string, FoundUrl>} found
 */
function scanScript(script, found) {
  const keyed = srcsetValues(script);
  /** @type {number[] | null} */
  let keys = null;
  /** @type {Map<string, Map<object, Set<number>>>} */
  const equals = new Map();
  for (const lit of script.literals) {
    const first = /** @type {Token} */ (tokenAt(script, lit.first));
    const last = /** @type {Token} */ (tokenAt(script, lit.last));
    const isKeyed = keyed.has(lit);
    const value = readingOf(script, lit, "value");
    const raw = lit.tagged ? readingOf(script, lit, "raw") : null;
    spend(value.text.length);
    if (!isKeyed && !URL_SIGNS.test(value.text) && (raw === null || !URL_SIGNS.test(raw.text))) {
      continue;
    }
    /** @type {Reading[]} */
    const seen = [];
    for (const name of lit.tagged ? [...READINGS, ...RAW_READINGS] : READINGS) {
      const reading = readingOf(script, lit, name);
      if (seen.some((r) => sameReading(r, reading))) continue;
      seen.push(reading);
      /** @type {Where} */
      const where = {
        kind: "literal",
        inTag: (eq) => {
          const map = equals.get(name) ?? tagPass(scriptPieces(script, name));
          equals.set(name, map);
          return map.get(lit)?.has(eq) === true;
        },
        extend: (reads, context, depth) => extendReads(script, lit, name, reads, context, depth),
        refreshNear: (at) => {
          keys ??= refreshKeys(script);
          // Where the value starts in the source: its piece's token, for a template literal.
          const piece = lit.pieces[countBefore(marksOf(script, lit, name), at)] ?? lit.pieces[0];
          const offset = tokenAt(script, piece?.place ?? lit.first)?.start ?? first.start;
          const key = keys[countBefore(keys, offset + 1) - 1];
          return key !== undefined && offset - key <= REFRESH_REACH;
        },
        keyed: isKeyed,
        template: lit.template,
        span: last.end - first.start,
      };
      scanReading(reading, where, found);
    }
  }
}

/**
 * The URLs a JSON text's strings name (keys included), each string read as a script's literal is
 * (a value whose key ends in srcset read whole as a list), or false when the text is no JSON.
 * @param {string} text
 * @param {Map<string, FoundUrl>} found
 */
function scanJson(text, found) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  spend(text.length);
  /**
   * @param {string} s
   * @param {boolean} keyed
   */
  const scanString = (s, keyed) => {
    if (!keyed && !URL_SIGNS.test(s)) return;
    for (const reading of readingsOf({ text: s, spelled: null, subst: null }, false)) {
      /** @type {Map<object, Set<number>> | null} */
      let tags = null;
      const piece = {
        literal: reading,
        reading,
        from: 0,
        to: reading.text.length,
        start: 0,
        end: s.length,
        n: 0,
        more: false,
        joined: false,
        cross: false,
        boundary: -1,
      };
      /** @type {Where} */
      const where = {
        kind: "literal",
        inTag: (eq) => {
          tags ??= tagPass([piece]);
          return tags.get(reading)?.has(eq) === true;
        },
        extend: null,
        refreshNear: () => false,
        keyed,
        template: false,
        span: s.length,
      };
      scanReading(reading, where, found);
    }
  };
  /**
   * @param {unknown} value
   * @param {string} key
   */
  const walk = (value, key) => {
    spend(1);
    if (typeof value === "string") scanString(value, key.toLowerCase().endsWith("srcset"));
    else if (Array.isArray(value)) for (const v of value) walk(v, "");
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        scanString(k, false);
        walk(v, k);
      }
    }
  };
  walk(parsed, "");
  return true;
}

/**
 * The URLs a text of markup or a stylesheet names, in every reading a browser may apply.
 * @param {string} text
 * @param {"markup" | "style"} kind
 * @param {Map<string, FoundUrl>} found
 */
function scanText(text, kind, found) {
  const base = { text, spelled: null, subst: null };
  const all = kind === "style" ? [readCssEscapes(base)] : readingsOf(base, true);
  /** @type {Where} */
  const where = {
    kind,
    inTag: () => false,
    extend: null,
    refreshNear: () => false,
    keyed: false,
    template: false,
    span: text.length,
  };
  for (const reading of all) scanReading(reading, where, found);
}

/**
 * What a text holds, as the rules read it: the URLs it names, the server settings it names, the
 * markers of a test seam or server-only code, and whether a sourceMappingURL points at a map; or,
 * for a script the tokenizer cannot read, why (`untokenized`), and nothing else.
 * @typedef {{ urls: FoundUrl[], names: Set<string>, markers: Array<{ rule: string, what: string }>,
 *   map: boolean, untokenized: string | null }} Analysis
 */

/**
 * The tokens of a script, or the reason the tokenizer gives for refusing it.
 * @param {string} text
 * @param {string} file
 * @returns {Token[] | string}
 */
function tokensOf(text, file) {
  try {
    const tokens = tokenize(text, file);
    spend(text.length + tokens.length);
    return tokens;
  } catch (error) {
    if (error instanceof TokenizeError) return error.message;
    throw error;
  }
}

/**
 * A script's markers, from its tokens: the build target's name or text, a seam's marker wherever
 * it stands (a literal, a regular expression, or a comment: a seam module's legal comment, which
 * the bundler keeps), a harness module's comment, an import of the harness or of a Node built-in
 * (a specifier after `from` or `import`, or the one argument of a dynamic import or a require
 * call), and Vite's stand-in for a Node module in a literal or a module comment.
 * @param {Token[]} tokens
 * @returns {Array<{ rule: string, what: string }>}
 */
function scriptMarkers(tokens) {
  /** @type {Map<string, { rule: string, what: string }>} */
  const markers = new Map();
  /** @param {string} rule @param {string} what */
  const add = (rule, what) => markers.set(what, { rule, what });
  /** @type {Token[]} */
  const sig = [];
  for (const t of tokens) {
    // A seam's marker is one wherever it stands, as a grep of the bundle finds it: in a literal,
    // a regular expression or a comment. Vite keeps a seam module's legal comment
    // (`/*! fin:test-seam */`, `//! ...`, `@license`, `@preserve`) and drops a literal the module
    // never uses.
    if (t.value.includes(SEAM_MARK)) add("seam", WHAT.seam);
    if (COMMENT.has(t.kind)) {
      if (t.kind !== "line-comment") continue;
      const path = MODULE_COMMENT.exec(t.value)?.[1] ?? "";
      if (path.includes(HARNESS_PATH)) add("seam", WHAT.region);
      if (path.includes(BROWSER_EXTERNAL)) add("server-only", WHAT.external);
      continue;
    }
    sig.push(t);
    if (t.kind === "name" && t.value === "__FIN_BUILD_TARGET__") add("seam", WHAT.target);
    if (!LITERAL.has(t.kind)) continue;
    if (BUILD_TARGET.test(t.value)) add("seam", WHAT.target);
    if (t.value.includes(BROWSER_EXTERNAL)) add("server-only", WHAT.external);
    if (t.kind !== "string" && t.kind !== "template") continue;
    const before = sig.at(-2);
    const beforeThat = sig.at(-3);
    const specifier =
      before !== undefined &&
      ((before.kind === "name" && (before.value === "from" || before.value === "import")) ||
        (before.kind === "punct" &&
          before.value === "(" &&
          beforeThat?.kind === "name" &&
          (beforeThat.value === "import" || beforeThat.value === "require")));
    if (!specifier) continue;
    if (HARNESS_SPECIFIER.test(t.value)) add("seam", WHAT.harness);
    if (NODE_SPECIFIER.test(t.value)) add("server-only", WHAT.node);
  }
  spend(tokens.length);
  return [...markers.values()];
}

/**
 * The server settings a script names: in its names, its literals and its regular expressions.
 * @param {Token[]} tokens
 * @returns {Set<string>}
 */
function scriptNames(tokens) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const t of tokens) {
    if (t.kind !== "name" && t.kind !== "regex" && !LITERAL.has(t.kind)) continue;
    if (!t.value.includes("FIN_")) continue;
    for (const m of t.value.matchAll(SETTING_NAME)) names.add(m[0]);
  }
  spend(tokens.length);
  return names;
}

/**
 * What a text holds, read as its kind is: a script through its tokens, JSON through JSON.parse,
 * markup and stylesheets as text.
 * @param {string} text
 * @param {string} kind "script", "json", "style" or "markup"
 * @param {string} file the file's name (a script's extension decides how the tokenizer reads it)
 * @returns {Analysis}
 */
function analyse(text, kind, file) {
  /** @type {Map<string, FoundUrl>} */
  const found = new Map();
  if (kind === "script") {
    const tokens = tokensOf(text, file);
    if (typeof tokens === "string") {
      return { urls: [], names: new Set(), markers: [], map: false, untokenized: tokens };
    }
    const script = scriptOf(tokens);
    scanScript(script, found);
    const map = tokens.some((t) => COMMENT.has(t.kind) && MAP_COMMENT.test(t.value));
    return {
      urls: [...found.values()],
      names: scriptNames(tokens),
      markers: scriptMarkers(tokens),
      map,
      untokenized: null,
    };
  }
  if (kind !== "json" || !scanJson(text, found)) {
    scanText(text, kind === "style" ? "style" : "markup", found);
  }
  spend(text.length);
  return {
    urls: [...found.values()],
    names: new Set([...text.matchAll(SETTING_NAME)].map((m) => m[0])),
    markers: TEXT_MARKERS.filter((m) => m.pattern.test(text)).map(({ rule, what }) => ({
      rule,
      what,
    })),
    map: MAP_TEXT.test(text),
    untokenized: null,
  };
}

/**
 * The URLs a text names, each read as a browser would, in every reading of the text: its origin,
 * or null when it has none the text fixes (a host built at run time), whether it carries a user
 * name or password, whether it ran past what the scanner reads, and whether its host is one the
 * scanner reads but no URL parser takes. A script the tokenizer cannot read names one URL, unread.
 * @param {string} text
 * @param {{ kind?: string, file?: string }} [options] "script", "json", "style" or "markup" (the
 *   default), and a script's file name (its extension decides how the tokenizer reads it)
 * @returns {FoundUrl[]}
 */
export function urlsIn(text, options = {}) {
  const kind = options.kind ?? "markup";
  const analysis = analyse(text, kind, options.file ?? "inline.js");
  if (analysis.untokenized !== null) {
    return [{ url: "", origin: null, userinfo: false, unread: true, unparsed: false }];
  }
  return analysis.urls;
}

/**
 * urlsIn's URLs and the work it did (`visits`: the characters and tokens its passes and
 * read-backs visited), stopped with an error once the work passes `limit`: a test's bound on the
 * work, which load cannot trip, in place of a clock's.
 * @param {string} text
 * @param {{ kind?: string, file?: string, limit?: number }} [options] as urlsIn's, and the bound
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
 * @param {{ kind?: string, file?: string }} [options] as urlsIn's
 * @returns {string[]}
 */
export function originsIn(text, options = {}) {
  return [...new Set(urlsIn(text, options).flatMap((u) => (u.origin === null ? [] : [u.origin])))];
}

/** The finding for a script the tokenizer cannot read. */
const UNTOKENIZED =
  "a script the tokenizer cannot read, so no rule can read it; a browser may read it otherwise:";

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
    const at = `${label}/${file}`;
    if (file.endsWith(".map")) {
      // A map's sources name every module bundled; its sourcesContent is the original text, whose
      // comments may name anything, so only the paths are read.
      const sources = mapSources(text);
      if (sources === null) {
        findings.push({ file: at, rule: "map", message: "a map that is not JSON" });
      } else if (sources.some((s) => s.includes(HARNESS_PATH))) {
        findings.push({ file: at, rule: "seam", message: WHAT.region });
      }
      continue;
    }
    const tokens = tokensOf(text, at);
    if (typeof tokens === "string") {
      findings.push({
        file: at,
        rule: "untokenized",
        message: `${UNTOKENIZED} ${clean(tokens, 200)}`,
      });
      continue;
    }
    for (const marker of scriptMarkers(tokens)) {
      if (marker.rule === "seam") findings.push({ file: at, rule: "seam", message: marker.what });
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
  const kind = SCRIPT_FILES.has(ext)
    ? "script"
    : JSON_FILES.has(ext)
      ? "json"
      : ext === ".css"
        ? "style"
        : "markup";
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
    const analysis = analyse(text, kind, at);
    if (analysis.untokenized !== null) {
      add("untokenized", `${UNTOKENIZED} ${clean(analysis.untokenized, 200)}`);
      continue;
    }
    if (analysis.map) {
      add("source-map", "a sourceMappingURL comment points at a map that is never served");
    }
    for (const { rule, what } of analysis.markers) add(rule, what);
    for (const name of analysis.names) {
      if (SAMPLE_NAMES.has(name)) continue;
      add(
        "setting-name",
        `names the server setting ${clean(name, 60)} (FW-C12: a build takes public settings only)`,
      );
    }
    for (const u of analysis.urls) {
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
