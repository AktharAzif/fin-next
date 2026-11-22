// The shared JavaScript and TypeScript tokenizer. A control path (tools/layout.json, CI-14): the
// checks that read code by its literal values (bundle-check in .github/scripts, MC-01 in
// ops/monitoring) read it through this one file, never through text patterns, which misread
// JavaScript (a regular expression taken for a division, a comment or a template taken for code).
// It is dependency-free: plain JavaScript with JSDoc types and no import at all.
//
// The interface. tokenize(text, file) returns every token of the file, in order:
//   { kind, start, end, line, value }, plus `raw` on strings and template pieces, `cooked` on
//   template pieces, `flags` on regular expressions and `jsx: true` on the tokens of JSX markup.
//   kind      value
//   hashbang        the text after `#!`
//   line-comment    the text after `//`, up to the line's end
//   block-comment   the text between `/*` and `*/`
//   string          the decoded value (every escape, line continuations included); in a JSX
//                   attribute (`jsx: true`) the text between the quotes as written, since JSX
//                   has no escapes; `raw` is the text between the quotes as written
//   template        a template literal with no substitution
//   template-head   `` `...${ ``, template-middle `}...${`, template-tail `` }...` ``: the cooked
//                   text; `raw` is the text between the delimiters as written. `cooked` is false
//                   only for a tagged template's piece holding an escape that has no cooked value
//                   (String.raw`\u`), whose value is then its raw text
//   regex           the pattern between the slashes; `flags` holds the flags
//   number          the literal as written
//   name            an identifier or keyword, its \u escapes decoded
//   private-name    `#name`, decoded
//   punct           the punctuator
//   jsx-text        JSX text between tags, as written (never a comment, never a string)
// `start` and `end` are UTF-16 offsets (`end` just past the token) and `line` is 1-based. A
// string or template piece starts at its quote, backtick or `}` and ends past its closing quote,
// backtick or `${`; a comment starts at its `//` or `/*`. syntaxOf(file) says how a file is read.
//
// How it reads. The file's extension decides its syntax as TypeScript decides it: .tsx, .jsx,
// .js, .mjs and .cjs allow JSX; .ts, .mts and .cts allow `<T>x` type assertions instead. Whether
// a `/` starts a regular expression is decided by the significant token before it: after an
// identifier, a number, a string, a template's end, `)`, `]` or `}` it divides, except after the
// keywords that take an operand (return, typeof, instanceof, in, new, delete, void, throw, case,
// do, else, yield, await, extends, default, break, continue, and `of` after a for head's binding:
// anywhere else `of` is an identifier, as TypeScript reads it); a `)` is judged by what it
// closes (the condition of if, while, for or with is followed by a statement) and a `}` by whether
// it closes a block or an expression (an object literal, a function or class expression, a
// template substitution); a postfix `++`, `--` or TypeScript's non-null `!` leaves an expression
// behind. TypeScript's types (annotations, `as` and `satisfies`, aliases, interfaces, type
// arguments and parameters) are followed far enough to know where each ends, so a `<` in a type
// is never JSX; a `<` that starts an expression in a JSX file is JSX unless it starts a generic
// arrow function (`<T,>`, `<T extends U>`), as TypeScript decides it. JSX text is text: a `//` or
// a quote in it is never a comment or a string.
//
// It fails closed. Text it cannot tokenize stops it with a TokenizeError that names the file,
// line and column: an unterminated string, template, comment, regular expression or JSX element,
// an invalid escape (outside a tagged template), a character that cannot stand in code, a
// closing bracket that does not match, a bracket or element left open, a JSX closing tag that
// does not match its opening tag, an HTML-like comment (`<!--`, or `-->` at a line's start),
// which a script and a module read differently, and a version-control conflict marker. It never
// skips a region it cannot read. Its reading is checked against TypeScript's own parser over
// node_modules, the repository's sources and the apps' builds (scripts/test/js-tokens.oracle.
// test.mjs).

/**
 * @typedef {"hashbang" | "line-comment" | "block-comment" | "string" | "template"
 *   | "template-head" | "template-middle" | "template-tail" | "regex" | "number" | "name"
 *   | "private-name" | "punct" | "jsx-text"} TokenKind
 */
/**
 * @typedef {object} Token
 * @property {TokenKind} kind
 * @property {number} start the offset of its first character
 * @property {number} end the offset just past its last character
 * @property {number} line the 1-based line of its first character
 * @property {string} value see the table in the header
 * @property {string} [raw] strings and template pieces: the text between the delimiters
 * @property {boolean} [cooked] template pieces: false when the piece has no cooked value
 * @property {string} [flags] regular expressions: the flags
 * @property {boolean} [jsx] the token belongs to JSX markup
 */

/** An input the tokenizer cannot read, with where it stands. */
export class TokenizeError extends Error {
  /**
   * @param {string} file
   * @param {number} line 1-based
   * @param {number} column 1-based, in UTF-16 code units
   * @param {string} reason
   */
  constructor(file, line, column, reason) {
    super(`${file}:${line}:${column}: cannot tokenize: ${reason}`);
    this.name = "TokenizeError";
    this.file = file;
    this.line = line;
    this.column = column;
    this.reason = reason;
  }
}

/**
 * How a file is read, from its name, as TypeScript reads it: JSX in .tsx, .jsx, .js, .mjs and
 * .cjs; TypeScript-only syntax that differs (type arguments on a JSX element) in .ts, .tsx, .mts
 * and .cts. Any other extension is refused.
 * @param {string} file
 * @returns {{ jsx: boolean, typescript: boolean }}
 */
export function syntaxOf(file) {
  const match = /\.([cm]?[jt]s|[jt]sx)$/i.exec(file);
  if (match === null) {
    throw new TokenizeError(file, 1, 1, "not a JavaScript or TypeScript file name");
  }
  const ext = (match[1] ?? "").toLowerCase();
  return { jsx: !/^[cm]?ts$/.test(ext), typescript: ext.includes("t") };
}

// --- Character classes ---------------------------------------------------------------------------

const ID_START = /^[\p{ID_Start}$_]$/u;
const ID_CONTINUE = /^[\p{ID_Continue}$\u200C\u200D]$/u;

/** @param {number} c */
const isDigit = (c) => c >= 48 && c <= 57;
/** @param {number} c */
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** @param {number} c */
const isAsciiIdStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95;
/** @param {number} c */
const isAsciiIdPart = (c) => isAsciiIdStart(c) || isDigit(c);
/** @param {number} c */
const isLineTerminator = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
/** JavaScript's white space other than line terminators. @param {number} c */
const isSpace = (c) =>
  c === 32 ||
  c === 9 ||
  c === 11 ||
  c === 12 ||
  c === 0xa0 ||
  c === 0xfeff ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000;
/**
 * @param {number} cp a code point
 * @param {boolean} first whether it starts the identifier
 */
const isIdChar = (cp, first) => {
  if (cp < 128) return first ? isAsciiIdStart(cp) : isAsciiIdPart(cp);
  return (first ? ID_START : ID_CONTINUE).test(String.fromCodePoint(cp));
};

// --- Words ---------------------------------------------------------------------------------------

// After these words an expression follows: a `/` starts a regular expression and a `{` an object.
const OPERAND_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "yield",
  "await",
  "extends",
  "default",
  "keyof",
  "var",
  "let",
  "const",
  "import",
]);
// After these words a statement starts.
const STATEMENT_START_WORDS = new Set(["else", "do", "try", "finally", "break", "continue"]);
// A line break after these words ends the statement (JavaScript's restricted productions).
const RESTRICTED_WORDS = new Set(["return", "break", "continue", "yield"]);
// These words start a statement when they follow a line break after a complete expression, since
// they cannot continue one (automatic semicolon insertion).
const STATEMENT_WORDS = new Set([
  "var",
  "let",
  "const",
  "function",
  "class",
  "if",
  "for",
  "while",
  "do",
  "return",
  "throw",
  "try",
  "switch",
  "break",
  "continue",
  "import",
  "export",
  "interface",
  "type",
  "enum",
  "declare",
  "namespace",
  "module",
  "abstract",
  "async",
  "debugger",
  "with",
]);
// The words that modify a class or object member, after which the member's key follows.
const MEMBER_MODIFIERS = new Set([
  "static",
  "get",
  "set",
  "async",
  "public",
  "private",
  "protected",
  "readonly",
  "abstract",
  "override",
  "declare",
  "accessor",
]);
// The words that start a type and are followed by more of it.
const TYPE_PREFIX_WORDS = new Set([
  "keyof",
  "typeof",
  "readonly",
  "unique",
  "infer",
  "asserts",
  "new",
  "abstract",
  "import",
]);
const PAREN_KEYWORDS = new Set(["if", "while", "for", "with"]);
const REGEX_FLAGS = "dgimsuyv";

// --- The tokenizer's own states ------------------------------------------------------------------

// What the previous significant token leaves: a statement may start, an expression is expected,
// or an expression just ended.
const START = 0;
const EXPR = 1;
const END = 2;

// Frames: what each open bracket (or JSX element) is.
const F_TOP = 0;
const F_BLOCK = 1; // a statement list: a block, a function or arrow body, a switch, a namespace
const F_CLASS = 2;
const F_OBJECT = 3; // an object literal, an import or export clause, a binding pattern
const F_PAREN = 4;
const F_BRACKET = 5;
const F_TEMPLATE = 6; // a template literal's substitution
const F_JSX = 7; // a JSX element or fragment
const F_JSX_EXPR = 8; // a JSX expression container or spread attribute
const F_TYPE_BRACE = 9;
const F_TYPE_PAREN = 10;
const F_TYPE_BRACKET = 11;
const F_TYPE_ANGLE = 12;

// Paren flags.
const P_KEYWORD = 1; // the condition of if, while, for or with
const P_FN_PARAMS = 2; // a function keyword's parameters
const P_FN_EXPR = 4; // ... of a function expression
const P_FOR = 8; // a for statement's head
const P_DECORATOR = 16; // a decorator's arguments
const P_DECORATOR_AT_START = 32; // ... of a decorator that starts a statement or member
const P_FN_TYPE = 64; // a function type's parameters
// Bracket and brace flags.
const B_COMPUTED_KEY = 128; // a computed member key
const B_DECL_PATTERN = 256; // a declaration's binding pattern
const B_ENDS_EXPR = 512; // a block that is a function or class expression's body

// Roles of a typed frame: what its closing leaves.
const R_NESTED = 0; // inside another type
const R_TOP = 1; // opened by a type's top level (Frame.tt)
const R_ASSERT = 2; // `<T>expr` or a generic arrow's parameters: an expression follows
const R_PARAMS = 3; // type parameters or arguments after a name
const R_INTERFACE = 4; // an interface's body: a statement follows
const R_JSX_ARGS = 5; // type arguments of a JSX element

// A type's top level (Frame.tt): where it was entered and where it stands.
const T_AS = 0; // `as` or `satisfies`: an expression goes on after it
const T_ANNOTATION = 1; // any other annotation, an alias: a statement may follow
const T_EXPECT = 0; // a type is expected
const T_AFTER = 1; // a type just ended, and may go on

// Function, class, interface and alias heads (Frame.head).
const H_FN = 1;
const H_CLASS = 2;
const H_INTERFACE = 3;
const H_ALIAS = 4;

// Declarations (Frame.decl).
const D_NONE = 0;
const D_BINDING = 1; // a binding name or pattern is expected
const D_AFTER = 2; // after a binding: `:` annotates it
const D_INIT = 3; // in its initializer

// JSX phases (Frame.phase).
const J_NAME = 0; // just after the element's name: TypeScript allows type arguments
const J_ATTRS = 1; // between attributes
const J_ATTR_NAME = 2; // after an attribute's name: `=` may follow
const J_VALUE = 3; // after `=`: the value
const J_CHILDREN = 4;

/**
 * @typedef {{ origin: number, state: number, ext: number, q: number, fnGroup: boolean }} TypeTop
 * @typedef {{ kind: number, expr: boolean, named: boolean }} Head
 * @typedef {object} Frame
 * @property {number} kind
 * @property {number} start where its opener stands
 * @property {boolean} typed its content is a type
 * @property {number} role for a typed frame, what its closing leaves (R_*)
 * @property {number} after for a typed frame opened by a type's top level, its state after
 * @property {number} flags P_* and B_* bits
 * @property {TypeTop | null} tt the type being read at this frame's own level
 * @property {number} ternary `?` awaiting their `:`
 * @property {number} cases `case` and `default` awaiting their `:`
 * @property {number} decl D_*
 * @property {Head | null} head a function, class, interface or alias head being read
 * @property {number} body a function body expected: 0 none, 1 declaration, 2 expression
 * @property {string} tag a JSX element's name ("" for a fragment)
 * @property {number} phase a JSX element's phase (J_*)
 * @property {boolean} tagged a template substitution's template is tagged
 */

/**
 * @param {number} kind
 * @param {number} start
 * @returns {Frame}
 */
function frame(kind, start) {
  return {
    kind,
    start,
    typed: false,
    role: R_NESTED,
    after: T_AFTER,
    flags: 0,
    tt: null,
    ternary: 0,
    cases: 0,
    decl: D_NONE,
    head: null,
    body: 0,
    tag: "",
    phase: J_ATTRS,
    tagged: false,
  };
}

const CLOSERS = ["}", "}", "}", "}", ")", "]", "}", "</>", "}", "}", ")", "]", ">"];

/**
 * The offsets where each line starts (after LF, CR, CRLF, LS or PS).
 * @param {string} text
 * @returns {number[]}
 */
function lineStarts(text) {
  const starts = [0];
  const terminator = /\r\n?|[\n\u2028\u2029]/g;
  for (let m = terminator.exec(text); m !== null; m = terminator.exec(text)) {
    starts.push(m.index + m[0].length);
  }
  return starts;
}

/**
 * Splits JavaScript or TypeScript source into tokens (see the header). Throws a TokenizeError on
 * anything it cannot read.
 * @param {string} text the file's content
 * @param {string} file the file's name: its extension decides the syntax, and errors name it
 * @returns {Token[]}
 */
export function tokenize(text, file) {
  const { jsx, typescript } = syntaxOf(file);
  const n = text.length;
  /** @type {Token[]} */
  const tokens = [];
  const starts = lineStarts(text);
  let lineIndex = 0;

  let pos = 0;
  // A line terminator stands between the previous significant token and the next.
  let newline = false;
  let state = START;
  // A function or class here is a declaration (a statement start, or after `export default`).
  let declPos = true;
  // The previous significant token, when it is a name that may be a keyword (not after a dot).
  let prevWord = "";
  // The previous significant token, when it is a punctuator.
  let prevPunct = "";
  let afterDot = false;
  // The previous token is a `)` that closed a parenthesis other than a statement's condition.
  let closedParen = false;
  // The previous token is a class or object member's key, or a modifier where a member starts.
  let memberKey = false;
  let memberMod = false;
  // A `for` awaits its head.
  let forPending = false;
  // A decorator being read: 0 none, 1 after `@`, 2 after a name, 3 after a dot.
  let deco = 0;
  let decoAtStart = false;
  let significant = false;

  /** The 1-based line of an offset. @param {number} at */
  const lineOf = (at) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= at) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const top0 = frame(F_TOP, 0);
  /** @type {Frame[]} */
  const frames = [top0];
  let top = top0;

  /**
   * @param {number} at
   * @param {string} reason
   * @returns {never}
   */
  const fail = (at, reason) => {
    const line = lineOf(at);
    throw new TokenizeError(file, line, at - (starts[line - 1] ?? 0) + 1, reason);
  };

  /**
   * @param {TokenKind} kind
   * @param {number} start
   * @param {number} end
   * @param {string} value
   * @returns {Token}
   */
  const emit = (kind, start, end, value) => {
    while ((starts[lineIndex + 1] ?? n + 1) <= start) lineIndex++;
    /** @type {Token} */
    const token = { kind, start, end, line: lineIndex + 1, value };
    tokens.push(token);
    return token;
  };

  /** @param {Frame} f */
  const push = (f) => {
    frames.push(f);
    top = f;
  };
  const pop = () => {
    const f = frames.pop();
    const parent = frames[frames.length - 1];
    if (f === undefined || parent === undefined) return fail(pos, "a bracket that closes nothing");
    top = parent;
    return f;
  };

  /**
   * Refuses a closing bracket that does not close the frame on top.
   * @param {string} closer
   * @param {Frame} f
   * @returns {never}
   */
  const mismatch = (closer, f) =>
    fail(
      pos,
      f.kind === F_TOP
        ? `a "${closer}" that closes nothing`
        : `a "${closer}" where "${CLOSERS[f.kind] ?? "?"}" should close what opened on line ${lineOf(f.start)}`,
    );

  /** Records a significant token: what follows it reads the state it leaves. */
  const settle = (
    /** @type {number} */ next,
    /** @type {string} */ word,
    /** @type {string} */ punct,
  ) => {
    state = next;
    declPos = next === START;
    prevWord = word;
    prevPunct = punct;
    afterDot = false;
    closedParen = false;
    memberKey = false;
    memberMod = false;
    newline = false;
    significant = true;
  };

  // --- Trivia -----------------------------------------------------------------------------------

  const lineComment = () => {
    const start = pos;
    pos += 2;
    while (pos < n && !isLineTerminator(text.charCodeAt(pos))) pos++;
    emit("line-comment", start, pos, text.slice(start + 2, pos));
  };
  const blockComment = () => {
    const start = pos;
    const close = text.indexOf("*/", pos + 2);
    if (close < 0) fail(start, "an unterminated comment");
    for (let i = start + 2; i < close; i++) {
      if (isLineTerminator(text.charCodeAt(i))) {
        newline = true;
        break;
      }
    }
    pos = close + 2;
    emit("block-comment", start, pos, text.slice(start + 2, close));
  };
  const skipTrivia = () => {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9) pos++;
      else if (isLineTerminator(c)) {
        newline = true;
        pos++;
      } else if (c === 47) {
        const d = text.charCodeAt(pos + 1);
        if (d === 47) lineComment();
        else if (d === 42) blockComment();
        else return;
      } else if (isSpace(c)) pos++;
      else return;
    }
  };

  /**
   * The offset of the next character that is not white space or a comment, from `from`, without
   * reading anything; with `sameLine`, -1 when a line ends first.
   * @param {number} from
   * @param {boolean} [sameLine]
   * @returns {number}
   */
  const peek = (from, sameLine = false) => {
    let p = from;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (isLineTerminator(c)) {
        if (sameLine) return -1;
        p++;
      } else if (isSpace(c)) p++;
      else if (c === 47 && text.charCodeAt(p + 1) === 47) {
        if (sameLine) return -1;
        while (p < n && !isLineTerminator(text.charCodeAt(p))) p++;
      } else if (c === 47 && text.charCodeAt(p + 1) === 42) {
        const close = text.indexOf("*/", p + 2);
        if (close < 0) return n;
        if (sameLine) {
          for (let i = p + 2; i < close; i++) if (isLineTerminator(text.charCodeAt(i))) return -1;
        }
        p = close + 2;
      } else return p;
    }
    return p;
  };
  /**
   * The plain (unescaped) word at `p`, or "".
   * @param {number} p
   */
  const wordAt = (p) => {
    let q = p;
    while (q < n && isAsciiIdPart(text.charCodeAt(q))) q++;
    return q > p && !isDigit(text.charCodeAt(p)) ? text.slice(p, q) : "";
  };
  /** Whether an identifier starts at `p`. @param {number} p */
  const idStartsAt = (p) => {
    if (p < 0 || p >= n) return false;
    const c = text.charCodeAt(p);
    if (c < 128) return isAsciiIdStart(c) || c === 92;
    return isIdChar(text.codePointAt(p) ?? 0, true);
  };

  // --- Literals ---------------------------------------------------------------------------------

  /**
   * Reads `\u` and its digits at `pos` (the backslash), returning the code point.
   * @returns {number}
   */
  const unicodeEscape = () => {
    const at = pos;
    if (text.charCodeAt(pos + 1) !== 117) fail(at, "a backslash that starts no \\u escape");
    if (text.charCodeAt(pos + 2) === 123) {
      let p = pos + 3;
      while (isHex(text.charCodeAt(p))) p++;
      if (p === pos + 3 || text.charCodeAt(p) !== 125) fail(at, "an invalid \\u{...} escape");
      const cp = Number.parseInt(text.slice(pos + 3, p), 16);
      if (cp > 0x10ffff) fail(at, "a \\u{...} escape past U+10FFFF");
      pos = p + 1;
      return cp;
    }
    for (let k = 2; k < 6; k++) {
      if (!isHex(text.charCodeAt(pos + k))) fail(at, "an invalid \\u escape");
    }
    pos += 6;
    return Number.parseInt(text.slice(at + 2, at + 6), 16);
  };

  /**
   * Reads an identifier at `pos`, decoding its escapes.
   * @param {boolean} [dash] a JSX name, which may hold `-`
   * @returns {{ value: string, escaped: boolean }}
   */
  const identifier = (dash = false) => {
    const start = pos;
    let value = "";
    let chunk = pos;
    let escaped = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      const first = pos === start;
      if (c < 128) {
        if (first ? isAsciiIdStart(c) : isAsciiIdPart(c) || (dash && c === 45)) {
          pos++;
          continue;
        }
        if (c !== 92) break;
        value += text.slice(chunk, pos);
        const at = pos;
        const cp = unicodeEscape();
        if (!isIdChar(cp, first)) fail(at, "a \\u escape that is no identifier character");
        value += String.fromCodePoint(cp);
        chunk = pos;
        escaped = true;
        continue;
      }
      const cp = text.codePointAt(pos) ?? 0;
      if (!isIdChar(cp, first)) break;
      pos += cp > 0xffff ? 2 : 1;
    }
    if (pos === start) fail(start, "an identifier was expected");
    return { value: value + text.slice(chunk, pos), escaped };
  };

  /**
   * Reads one escape sequence at `pos` (the backslash) in a string or template literal.
   * @param {boolean} template a template's escape (no legacy octal, no \8 or \9)
   * @param {number} literalStart for errors
   * @returns {string | null} the value, or null for an invalid escape in a template
   */
  const readEscape = (template, literalStart) => {
    const at = pos;
    if (pos + 1 >= n) fail(literalStart, "an unterminated literal");
    const c = text.charCodeAt(pos + 1);
    switch (c) {
      case 110:
        pos += 2;
        return "\n";
      case 116:
        pos += 2;
        return "\t";
      case 114:
        pos += 2;
        return "\r";
      case 98:
        pos += 2;
        return "\b";
      case 102:
        pos += 2;
        return "\f";
      case 118:
        pos += 2;
        return "\v";
      case 13:
        pos += text.charCodeAt(pos + 2) === 10 ? 3 : 2;
        return "";
      case 10:
      case 0x2028:
      case 0x2029:
        pos += 2;
        return "";
      case 120: {
        if (isHex(text.charCodeAt(pos + 2)) && isHex(text.charCodeAt(pos + 3))) {
          pos += 4;
          return String.fromCharCode(Number.parseInt(text.slice(at + 2, at + 4), 16));
        }
        if (template) {
          pos += 2;
          return null;
        }
        return fail(at, "an invalid \\x escape");
      }
      case 117: {
        if (template) {
          const braced = text.charCodeAt(pos + 2) === 123;
          let p = pos + (braced ? 3 : 2);
          while (isHex(text.charCodeAt(p)) && (braced || p < pos + 6)) p++;
          const digits = p - pos - (braced ? 3 : 2);
          const valid = braced
            ? digits > 0 &&
              text.charCodeAt(p) === 125 &&
              Number.parseInt(text.slice(pos + 3, p), 16) <= 0x10ffff
            : digits === 4;
          if (!valid) {
            pos += 2;
            return null;
          }
        }
        return String.fromCodePoint(unicodeEscape());
      }
      default:
        break;
    }
    if (c >= 48 && c <= 55) {
      const next = text.charCodeAt(pos + 2);
      if (c === 48 && !isDigit(next)) {
        pos += 2;
        return "\0";
      }
      if (template) {
        pos += 2;
        return null;
      }
      let p = pos + 2;
      const max = c <= 51 ? 3 : 2;
      while (p < pos + 1 + max && text.charCodeAt(p) >= 48 && text.charCodeAt(p) <= 55) p++;
      pos = p;
      return String.fromCharCode(Number.parseInt(text.slice(at + 1, p), 8));
    }
    if (c === 56 || c === 57) {
      pos += 2;
      return template ? null : String.fromCharCode(c);
    }
    const cp = text.codePointAt(pos + 1) ?? c;
    pos += cp > 0xffff ? 3 : 2;
    return String.fromCodePoint(cp);
  };

  /** Reads a quoted string at `pos`. */
  const string = () => {
    const start = pos;
    const quote = text.charCodeAt(pos);
    pos++;
    let value = "";
    let chunk = pos;
    for (;;) {
      if (pos >= n) fail(start, "an unterminated string");
      const c = text.charCodeAt(pos);
      if (c === quote) break;
      if (c === 92) {
        value += text.slice(chunk, pos);
        value += readEscape(false, start) ?? "";
        chunk = pos;
      } else if (c === 10 || c === 13) fail(start, "an unterminated string");
      else pos++;
    }
    value += text.slice(chunk, pos);
    pos++;
    emit("string", start, pos, value).raw = text.slice(start + 1, pos - 1);
  };

  /** Reads a JSX attribute's quoted value: no escapes, and it may span lines. */
  const jsxString = () => {
    const start = pos;
    const close = text.indexOf(text.charAt(pos), pos + 1);
    if (close < 0) fail(start, "an unterminated JSX attribute string");
    pos = close + 1;
    const token = emit("string", start, pos, text.slice(start + 1, close));
    token.raw = token.value;
    token.jsx = true;
  };

  /**
   * Reads a template piece from `pos`: its backtick, or the `}` that closes a substitution.
   * @param {boolean} typed a template literal type
   * @param {boolean} tagged a tagged template (an invalid escape is allowed)
   * @param {boolean} fromTop opened by a type's top level
   */
  const template = (typed, tagged, fromTop) => {
    const start = pos;
    const head = text.charCodeAt(pos) === 96;
    pos++;
    let cooked = "";
    let chunk = pos;
    let invalid = false;
    for (;;) {
      if (pos >= n) fail(start, "an unterminated template literal");
      const c = text.charCodeAt(pos);
      if (c === 96) {
        cooked += text.slice(chunk, pos);
        const raw = text.slice(start + 1, pos);
        pos++;
        piece(head ? "template" : "template-tail", start, raw, cooked, invalid, tagged);
        if (fromTop) {
          const tt = top.tt;
          if (tt !== null) tt.state = T_AFTER;
        } else if (!typed) settle(END, "", "");
        return;
      }
      if (c === 36 && text.charCodeAt(pos + 1) === 123) {
        cooked += text.slice(chunk, pos);
        const raw = text.slice(start + 1, pos);
        pos += 2;
        piece(head ? "template-head" : "template-middle", start, raw, cooked, invalid, tagged);
        const f = frame(F_TEMPLATE, start);
        f.typed = typed;
        f.role = fromTop ? R_TOP : R_NESTED;
        f.tagged = tagged;
        push(f);
        if (!typed) settle(EXPR, "", "${");
        return;
      }
      if (c === 92) {
        cooked += text.slice(chunk, pos);
        const value = readEscape(true, start);
        if (value === null) invalid = true;
        else cooked += value;
        chunk = pos;
      } else if (c === 13) {
        cooked += `${text.slice(chunk, pos)}\n`;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        chunk = pos;
      } else pos++;
    }
  };
  /**
   * @param {TokenKind} kind
   * @param {number} start
   * @param {string} raw
   * @param {string} cooked
   * @param {boolean} invalid
   * @param {boolean} tagged
   */
  const piece = (kind, start, raw, cooked, invalid, tagged) => {
    if (invalid && !tagged) fail(start, "an invalid escape in an untagged template literal");
    const token = emit(kind, start, pos, invalid ? raw : cooked);
    token.raw = raw;
    token.cooked = !invalid;
  };

  /** Reads a regular expression literal at `pos`. */
  const regex = () => {
    const start = pos;
    pos++;
    let inClass = false;
    for (;;) {
      if (pos >= n) fail(start, "an unterminated regular expression");
      const c = text.charCodeAt(pos);
      if (isLineTerminator(c)) fail(start, "an unterminated regular expression");
      if (c === 92) {
        pos++;
        if (pos >= n || isLineTerminator(text.charCodeAt(pos))) {
          fail(start, "an unterminated regular expression");
        }
        pos++;
      } else if (inClass) {
        if (c === 93) inClass = false;
        pos++;
      } else if (c === 91) {
        inClass = true;
        pos++;
      } else if (c === 47) {
        pos++;
        break;
      } else pos++;
    }
    const bodyEnd = pos - 1;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c < 128 ? isAsciiIdPart(c) : isIdChar(text.codePointAt(pos) ?? 0, false)) {
        pos += (text.codePointAt(pos) ?? 0) > 0xffff ? 2 : 1;
      } else break;
    }
    const flags = text.slice(bodyEnd + 1, pos);
    for (const [k, flag] of [...flags].entries()) {
      if (!REGEX_FLAGS.includes(flag) || flags.indexOf(flag) !== k) {
        fail(start, "a regular expression with an invalid flag");
      }
    }
    if (flags.includes("u") && flags.includes("v")) {
      fail(start, "a regular expression with both the u and v flags");
    }
    emit("regex", start, pos, text.slice(start + 1, bodyEnd)).flags = flags;
  };

  /**
   * Reads digits of a radix with numeric separators, returning how many were read.
   * @param {(c: number) => boolean} digit
   * @param {boolean} separators
   */
  const digits = (digit, separators) => {
    const from = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (digit(c)) pos++;
      else if (c === 95 && separators) {
        if (pos === from || !digit(text.charCodeAt(pos - 1)) || !digit(text.charCodeAt(pos + 1))) {
          fail(pos, "a misplaced numeric separator");
        }
        pos++;
      } else break;
    }
    return pos - from;
  };
  /** Reads a numeric literal at `pos`. */
  const number = () => {
    const start = pos;
    const c = text.charCodeAt(pos);
    const next = text.charCodeAt(pos + 1) | 32;
    if (c === 48 && (next === 120 || next === 111 || next === 98)) {
      pos += 2;
      /** @type {(d: number) => boolean} */
      const digit =
        next === 120
          ? isHex
          : next === 111
            ? (d) => d >= 48 && d <= 55
            : (d) => d === 48 || d === 49;
      if (digits(digit, true) === 0) fail(start, "a numeric literal with no digits");
      if (text.charCodeAt(pos) === 110) pos++;
    } else if (c === 48 && isDigit(text.charCodeAt(pos + 1))) {
      // A legacy octal literal, or a decimal one with a leading zero.
      digits(isDigit, false);
      const octal = /^[0-7]+$/.test(text.slice(start, pos));
      if (!octal) fraction();
    } else {
      let integer = true;
      if (c !== 46) digits(isDigit, true);
      else integer = false;
      if (fraction()) integer = false;
      if (integer && text.charCodeAt(pos) === 110) pos++;
    }
    if (pos < n && (idStartsAt(pos) || isDigit(text.charCodeAt(pos)))) {
      fail(pos, "an identifier or digit directly after a number");
    }
    emit("number", start, pos, text.slice(start, pos));
  };
  /** Reads a number's fraction and exponent, returning whether there was either. */
  const fraction = () => {
    let any = false;
    if (text.charCodeAt(pos) === 46) {
      const start = pos;
      pos++;
      const count = digits(isDigit, true);
      if (count === 0 && start > 0 && !isDigit(text.charCodeAt(start - 1))) {
        fail(start, "a lone dot where a number was expected");
      }
      any = true;
    }
    if ((text.charCodeAt(pos) | 32) === 101) {
      pos++;
      const sign = text.charCodeAt(pos);
      if (sign === 43 || sign === 45) pos++;
      if (digits(isDigit, true) === 0) fail(pos, "an exponent with no digits");
      any = true;
    }
    return any;
  };

  // --- Punctuators ------------------------------------------------------------------------------

  /**
   * The punctuator at `pos`, longest first, in an expression (`<` and `>` included).
   * @returns {string}
   */
  const punctuator = () => {
    const c = text.charAt(pos);
    const d = text.charAt(pos + 1);
    const e = text.charAt(pos + 2);
    switch (c) {
      case "{":
      case "}":
      case "(":
      case ")":
      case "[":
      case "]":
      case ";":
      case ",":
      case "~":
      case "@":
      case ":":
        return c;
      case ".":
        return d === "." && e === "." ? "..." : ".";
      case "?":
        if (d === "?") return e === "=" ? "??=" : "??";
        if (d === "." && !isDigit(text.charCodeAt(pos + 2))) return "?.";
        return "?";
      case "=":
        if (d === "=") return e === "=" ? "===" : "==";
        return d === ">" ? "=>" : "=";
      case "!":
        if (d === "=") return e === "=" ? "!==" : "!=";
        return "!";
      case "+":
      case "-":
        if (d === c) return c + c;
        return d === "=" ? `${c}=` : c;
      case "*":
        if (d === "*") return e === "=" ? "**=" : "**";
        return d === "=" ? "*=" : "*";
      case "%":
      case "^":
        return d === "=" ? `${c}=` : c;
      case "&":
      case "|":
        if (d === c) return e === "=" ? `${c}${c}=` : c + c;
        return d === "=" ? `${c}=` : c;
      case "<":
        if (d === "<") return e === "=" ? "<<=" : "<<";
        return d === "=" ? "<=" : "<";
      case ">":
        if (d === ">") {
          if (e === ">") return text.charAt(pos + 3) === "=" ? ">>>=" : ">>>";
          return e === "=" ? ">>=" : ">>";
        }
        return d === "=" ? ">=" : ">";
      case "/":
        return d === "=" ? "/=" : "/";
      default:
        return "";
    }
  };

  /**
   * Emits a punctuator token of `value` at `pos` and moves past it.
   * @param {string} value
   * @param {boolean} [inJsx]
   */
  const punct = (value, inJsx = false) => {
    const token = emit("punct", pos, pos + value.length, value);
    if (inJsx) token.jsx = true;
    pos += value.length;
  };

  /** Refuses a version-control conflict marker at a line's start. */
  const conflictMarker = () => {
    if (pos > 0 && !isLineTerminator(text.charCodeAt(pos - 1))) return;
    const c = text.charAt(pos);
    if (text.startsWith(c.repeat(7), pos)) fail(pos, "a version-control conflict marker");
  };

  // --- Types ------------------------------------------------------------------------------------

  /**
   * Whether a `(` at `at` in a type starts a function type's parameters, as TypeScript decides:
   * `()`, `(...`, or a parameter name or pattern followed by `:`, `,`, `?`, `=` or `) =>`.
   * @param {number} at
   */
  const functionTypeAt = (at) => {
    let p = peek(at + 1);
    const c = text.charCodeAt(p);
    if (c === 41 || text.startsWith("...", p)) return true;
    if (c === 123 || c === 91) {
      // A binding pattern: find its end, counting brackets and skipping strings.
      let depth = 0;
      for (; p < n; p++) {
        const ch = text.charCodeAt(p);
        if (ch === 123 || ch === 91 || ch === 40) depth++;
        else if (ch === 125 || ch === 93 || ch === 41) {
          depth--;
          if (depth === 0) break;
        } else if (ch === 34 || ch === 39 || ch === 96) {
          const close = text.indexOf(text.charAt(p), p + 1);
          if (close < 0) return false;
          p = close;
        }
      }
      p++;
    } else {
      let word = wordAt(p);
      while (MEMBER_MODIFIERS.has(word) && idStartsAt(peek(p + word.length))) {
        p = peek(p + word.length);
        word = wordAt(p);
      }
      if (!idStartsAt(p)) return false;
      const save = pos;
      pos = p;
      try {
        identifier();
        p = pos;
      } finally {
        pos = save;
      }
    }
    p = peek(p);
    const d = text.charAt(p);
    if (d === ":" || d === "," || d === "?") return true;
    if (d === "=") return text.charAt(p + 1) !== "=" && text.charAt(p + 1) !== ">";
    return d === ")" && text.startsWith("=>", peek(p + 1));
  };

  /**
   * Whether the character at `pos` goes on with the type `tt` is reading (TypeScript's rules,
   * as far as where a type ends).
   * @param {TypeTop} tt
   * @param {number} c
   */
  const typeGoesOn = (tt, c) => {
    const d = text.charCodeAt(pos + 1);
    if (tt.state === T_EXPECT) {
      return (
        idStartsAt(pos) ||
        c === 34 ||
        c === 39 ||
        c === 96 ||
        isDigit(c) ||
        (c === 46 && isDigit(d)) ||
        c === 45 ||
        c === 123 ||
        c === 40 ||
        c === 91 ||
        c === 60 ||
        ((c === 124 || c === 38) && d !== c && d !== 61)
      );
    }
    switch (c) {
      case 124:
      case 38:
        return d !== c && d !== 61;
      case 46:
        return d !== 46 && !isDigit(d);
      case 91:
      case 60:
        return !newline;
      case 63:
        return tt.ext > 0 && d !== 46 && d !== 63;
      case 58:
        return tt.q > 0;
      case 61:
        return d === 62 && tt.fnGroup;
      default: {
        const word = wordAt(pos);
        if (word === "extends" || word === "is") return true;
        return (word === "as" || word === "satisfies") && tt.origin === T_AS && !newline;
      }
    }
  };

  /** Ends the type read at the top frame's own level. */
  const endType = () => {
    const tt = top.tt;
    if (tt === null) return;
    top.tt = null;
    // What follows the type reads the state it leaves; a line break before it still counts.
    state = tt.origin === T_AS ? END : START;
    declPos = state === START;
    prevWord = "";
    prevPunct = "";
    afterDot = false;
    closedParen = false;
    memberKey = false;
    memberMod = false;
  };

  /**
   * Opens a typed frame.
   * @param {number} kind
   * @param {number} role
   * @param {number} after
   */
  const openTyped = (kind, role, after) => {
    const f = frame(kind, pos);
    f.typed = true;
    f.role = role;
    f.after = after;
    return f;
  };

  /** Closes the typed frame on top with the character at `pos`. */
  const closeTyped = (/** @type {string} */ closer) => {
    const f = top;
    if (!f.typed || CLOSERS[f.kind] !== closer) mismatch(closer, f);
    punct(closer, f.role === R_JSX_ARGS);
    pop();
    if (f.role === R_TOP) {
      const tt = top.tt;
      if (tt !== null) {
        tt.state = f.after;
        tt.fnGroup = (f.flags & P_FN_TYPE) !== 0;
      }
    } else if (f.role === R_ASSERT) settle(EXPR, "", "");
    else if (f.role === R_PARAMS) settle(END, "", "");
    else if (f.role === R_INTERFACE) settle(START, "", "");
  };

  /**
   * Reads one token in a type: at a type's top level (`tt`) or inside a typed frame.
   * @param {number} c the character at `pos`
   * @param {TypeTop | null} tt
   */
  const typeToken = (c, tt) => {
    const role = tt === null ? R_NESTED : R_TOP;
    const expect = tt !== null && tt.state === T_EXPECT;
    if (tt !== null) tt.fnGroup = false;
    if (c === 34 || c === 39) {
      string();
      if (tt !== null) tt.state = T_AFTER;
      return;
    }
    if (c === 96) {
      template(true, false, tt !== null);
      return;
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(pos + 1)))) {
      number();
      if (tt !== null) tt.state = T_AFTER;
      return;
    }
    if (idStartsAt(pos)) {
      const start = pos;
      const { value } = identifier();
      emit("name", start, pos, value);
      if (tt !== null) {
        if (expect) tt.state = TYPE_PREFIX_WORDS.has(value) ? T_EXPECT : T_AFTER;
        else if (value === "extends") {
          tt.ext++;
          tt.state = T_EXPECT;
        } else tt.state = T_EXPECT; // `is`, `as`, `satisfies`
      }
      return;
    }
    switch (c) {
      case 123: {
        const f = openTyped(F_TYPE_BRACE, role, T_AFTER);
        punct("{");
        push(f);
        return;
      }
      case 40: {
        const f = openTyped(F_TYPE_PAREN, role, T_AFTER);
        if (expect && functionTypeAt(pos)) f.flags |= P_FN_TYPE;
        punct("(");
        push(f);
        return;
      }
      case 91: {
        const f = openTyped(F_TYPE_BRACKET, role, T_AFTER);
        punct("[");
        push(f);
        return;
      }
      case 60: {
        const f = openTyped(F_TYPE_ANGLE, role, expect ? T_EXPECT : T_AFTER);
        punct("<");
        push(f);
        return;
      }
      case 125:
        if (top.kind === F_TEMPLATE && top.typed) {
          const f = pop();
          template(true, false, f.role === R_TOP);
          return;
        }
        closeTyped("}");
        return;
      case 41:
        closeTyped(")");
        return;
      case 93:
        closeTyped("]");
        return;
      case 62:
        closeTyped(">");
        return;
      default:
        break;
    }
    let value = "";
    const d = text.charAt(pos + 1);
    switch (c) {
      case 61:
        value = d === ">" ? "=>" : "=";
        break;
      case 46:
        value = text.startsWith("...", pos) ? "..." : ".";
        break;
      case 63:
      case 58:
      case 44:
      case 59:
      case 124:
      case 38:
      case 45:
      case 43:
        value = text.charAt(pos);
        break;
      default:
        fail(pos, `a character that cannot stand in a type (U+${hex(c)})`);
    }
    punct(value);
    if (tt !== null) {
      if (value === "?") {
        tt.ext--;
        tt.q++;
      } else if (value === ":") tt.q--;
      tt.state = T_EXPECT;
    }
  };

  /**
   * Starts reading a type at the top frame's own level.
   * @param {number} origin
   */
  const startType = (origin) => {
    top.tt = { origin, state: T_EXPECT, ext: 0, q: 0, fnGroup: false };
  };

  // --- JSX --------------------------------------------------------------------------------------

  /**
   * Reads a JSX element's or attribute's name: identifiers that may hold `-`, joined by one `:`
   * or by dots.
   * @param {boolean} element
   * @returns {string}
   */
  const jsxName = (element) => {
    let name = "";
    for (;;) {
      const start = pos;
      const { value } = identifier(true);
      emit("name", start, pos, value).jsx = true;
      name += value;
      const p = peek(pos);
      const c = text.charAt(p);
      if (c === ":" && !name.includes(":")) {
        pos = p;
        skipTrivia();
        punct(":", true);
        skipTrivia();
        name += ":";
      } else if (c === "." && element && !name.includes(":")) {
        pos = p;
        skipTrivia();
        punct(".", true);
        skipTrivia();
        name += ".";
      } else return name;
    }
  };

  /** Opens a JSX element or fragment at `pos` (its `<`). */
  const openJsx = () => {
    const start = pos;
    punct("<", true);
    skipTrivia();
    const f = frame(F_JSX, start);
    if (text.charCodeAt(pos) === 62) {
      punct(">", true);
      f.phase = J_CHILDREN;
    } else {
      f.tag = jsxName(true);
      f.phase = J_NAME;
    }
    push(f);
  };

  /** After a JSX element or fragment closes: its parent element goes on, or an expression ends. */
  const jsxClosed = () => {
    if (top.kind !== F_JSX) settle(END, "", "");
  };

  /** Reads the next part of a JSX element's opening tag. */
  const jsxTag = () => {
    const f = top;
    skipTrivia();
    if (pos >= n) fail(f.start, "an unterminated JSX tag");
    const c = text.charCodeAt(pos);
    if (f.phase === J_NAME && c === 60 && typescript) {
      f.phase = J_ATTRS;
      const angle = openTyped(F_TYPE_ANGLE, R_JSX_ARGS, T_AFTER);
      punct("<", true);
      push(angle);
      return;
    }
    if (f.phase === J_VALUE) {
      f.phase = J_ATTRS;
      if (c === 34 || c === 39) jsxString();
      else if (c === 123) {
        punct("{", true);
        push(frame(F_JSX_EXPR, pos - 1));
        settle(EXPR, "", "{");
      } else if (c === 60) openJsx();
      else fail(pos, "a JSX attribute value was expected");
      return;
    }
    if (c === 61 && f.phase === J_ATTR_NAME) {
      punct("=", true);
      f.phase = J_VALUE;
      return;
    }
    f.phase = J_ATTRS;
    if (c === 47) {
      punct("/", true);
      skipTrivia();
      if (text.charCodeAt(pos) !== 62) fail(pos, "a `>` was expected after `/` in a JSX tag");
      punct(">", true);
      pop();
      jsxClosed();
    } else if (c === 62) {
      punct(">", true);
      f.phase = J_CHILDREN;
    } else if (c === 123) {
      punct("{", true);
      push(frame(F_JSX_EXPR, pos - 1));
      settle(EXPR, "", "{");
    } else if (idStartsAt(pos)) {
      jsxName(false);
      f.phase = J_ATTR_NAME;
    } else fail(pos, `a character that cannot stand in a JSX tag (U+${hex(c)})`);
  };

  /** Reads a JSX element's children up to the next `{`, `<` or closing tag. */
  const jsxChildren = () => {
    const f = top;
    const start = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 60 || c === 123) break;
      if (c === 62 || c === 125) fail(pos, `a "${text.charAt(pos)}" in JSX text`);
      pos++;
    }
    if (pos > start) emit("jsx-text", start, pos, text.slice(start, pos)).jsx = true;
    if (pos >= n) fail(f.start, `an unterminated JSX element <${f.tag}>`);
    if (text.charCodeAt(pos) === 123) {
      punct("{", true);
      push(frame(F_JSX_EXPR, pos - 1));
      settle(EXPR, "", "{");
      return;
    }
    if (text.charCodeAt(pos + 1) !== 47) {
      openJsx();
      return;
    }
    const closeAt = pos;
    punct("</", true);
    skipTrivia();
    const name = text.charCodeAt(pos) === 62 ? "" : jsxName(true);
    skipTrivia();
    if (text.charCodeAt(pos) !== 62) fail(pos, "a `>` was expected to end a JSX closing tag");
    if (name !== f.tag) fail(closeAt, `a JSX closing tag </${name}> for <${f.tag}>`);
    punct(">", true);
    pop();
    jsxClosed();
  };

  /**
   * Whether a `<` at `pos` that starts an expression in a JSX file starts a generic arrow
   * function's type parameters (`<T,>`, `<T = U>`, `<T extends U>`), as TypeScript decides.
   */
  const genericArrowAt = () => {
    let p = peek(pos + 1);
    if (wordAt(p) === "const" && idStartsAt(peek(p + 5))) p = peek(p + 5);
    if (!idStartsAt(p)) return false;
    const save = pos;
    pos = p;
    try {
      identifier();
      p = peek(pos);
    } finally {
      pos = save;
    }
    const c = text.charAt(p);
    if (c === ",") return true;
    if (c === "=") return text.charAt(p + 1) !== "=" && text.charAt(p + 1) !== ">";
    if (wordAt(p) !== "extends") return false;
    const q = peek(p + 7);
    const d = text.charAt(q);
    if (d === ">") return false;
    if (d === "=") return text.charAt(q + 1) === "=" || text.charAt(q + 1) === ">";
    if (d === "/") return text.charAt(q + 1) === "=";
    return true;
  };

  // --- Code -------------------------------------------------------------------------------------

  /** Whether the next token stands where a class or object member's key starts. */
  const memberPosition = () => {
    if (top.kind === F_CLASS) {
      return memberMod || state === START || (state === END && newline);
    }
    if (top.kind === F_OBJECT) return memberMod || prevPunct === "{" || prevPunct === ",";
    return false;
  };

  /**
   * Reads a name in code and what it does to the state.
   * @param {number} start
   */
  const name = (start) => {
    const wasAfterDot = afterDot;
    const { value, escaped } = identifier();
    emit("name", start, pos, value);
    const f = top;
    if (wasAfterDot || escaped) {
      if (deco === 1 || deco === 3) deco = 2;
      settle(END, "", "");
      return;
    }
    if (deco === 1 || deco === 3) {
      deco = 2;
      settle(END, "", "");
      return;
    }
    if (memberPosition()) {
      const modifier = MEMBER_MODIFIERS.has(value) && idOrKeyNext(pos);
      settle(END, "", "");
      memberKey = true;
      memberMod = modifier;
      if (modifier) state = START;
      return;
    }
    // A name that follows a line break after a complete expression starts a statement when it
    // cannot go on with it.
    if (newline && state === END && STATEMENT_WORDS.has(value)) {
      state = START;
      declPos = true;
    }
    const atStart = state === START;
    const decl = atStart || declPos;
    const head = f.head;
    if (head !== null && head.kind !== H_ALIAS && !head.named) {
      head.named = value !== "extends" && value !== "implements";
      settle(END, "", "");
      return;
    }
    if (head !== null && head.kind === H_ALIAS) {
      head.named = true;
      settle(END, "", "");
      return;
    }
    if (f.decl === D_BINDING) f.decl = D_AFTER;
    else if (f.decl === D_AFTER) f.decl = D_NONE;
    switch (value) {
      case "var":
      case "let":
      case "const": {
        const p = peek(pos);
        const binding = idStartsAt(p) || text.charAt(p) === "{" || text.charAt(p) === "[";
        const forHead = f.kind === F_PAREN && (f.flags & P_FOR) !== 0 && prevPunct === "(";
        if (binding && (forHead || (atStart && (f.kind === F_TOP || f.kind === F_BLOCK)))) {
          f.decl = D_BINDING;
        }
        // `let` with no binding after it is an identifier (a sloppy-mode script may use it so).
        settle(binding || value !== "let" ? EXPR : END, value, "");
        return;
      }
      case "function":
      case "class": {
        if (keyNext(pos, value === "class")) break;
        f.head = { kind: value === "function" ? H_FN : H_CLASS, expr: !decl, named: false };
        settle(EXPR, "", "");
        return;
      }
      case "interface":
      case "type": {
        if (!decl || !idStartsAt(peek(pos, true))) break;
        f.head = { kind: value === "type" ? H_ALIAS : H_INTERFACE, expr: false, named: false };
        settle(EXPR, "", "");
        return;
      }
      case "export":
        if (atStart) {
          settle(START, "export", "");
          return;
        }
        break;
      case "declare":
      case "abstract":
      case "async": {
        const next = peek(pos, true);
        if (decl && next >= 0 && idStartsAt(next)) {
          const word = wordAt(next);
          if (value === "declare" || word === "class" || word === "function") {
            const keep = state;
            settle(keep === START ? START : EXPR, "", "");
            declPos = true;
            return;
          }
        }
        break;
      }
      case "default":
        if (prevWord === "export") {
          settle(EXPR, "default", "");
          declPos = true;
          return;
        }
        if ((f.kind === F_TOP || f.kind === F_BLOCK) && text.charAt(peek(pos)) === ":") f.cases++;
        settle(EXPR, "default", "");
        return;
      case "case":
        if (f.kind === F_TOP || f.kind === F_BLOCK) f.cases++;
        settle(EXPR, "case", "");
        return;
      case "for":
        forPending = true;
        settle(EXPR, "for", "");
        return;
      case "of":
        // A keyword only after a for head's binding or target (`for (const x of …)`); anywhere
        // else an identifier (`of / total`), after which a `/` divides.
        if (state === END && f.kind === F_PAREN && (f.flags & P_FOR) !== 0) {
          settle(EXPR, value, "");
          return;
        }
        break;
      case "as":
      case "satisfies":
        if (state === END && !newline) {
          settle(EXPR, "", "");
          startType(T_AS);
          return;
        }
        break;
      default:
        if (OPERAND_WORDS.has(value)) {
          settle(EXPR, value, "");
          return;
        }
        if (STATEMENT_START_WORDS.has(value) || value === "debugger") {
          settle(START, value, "");
          return;
        }
        if (PAREN_KEYWORDS.has(value) || value === "switch" || value === "catch") {
          settle(EXPR, value, "");
          return;
        }
    }
    settle(END, value, "");
  };

  /**
   * Whether the word just read is a property key rather than a keyword (`{ class: 1 }`,
   * `x = { function }`): the next character is `:`, `,`, `}`, `?`, `=`, `;` or (for `class`) `(`.
   * @param {number} p just past the word
   * @param {boolean} paren whether `(` also makes it a key
   */
  const keyNext = (p, paren) => {
    const q = peek(p);
    const c = text.charAt(q);
    if (c === ":" || c === "," || c === "}" || c === "?" || c === ";" || c === ")") return true;
    if (c === "=") return text.charAt(q + 1) !== "=" && text.charAt(q + 1) !== ">";
    return paren && c === "(";
  };
  /**
   * Whether a member modifier just read is followed by the member it modifies (a key or `*`,
   * `[` or `#`), not used as the key itself.
   * @param {number} p just past the word
   */
  const idOrKeyNext = (p) => {
    const q = peek(p, true);
    if (q < 0) return false;
    const c = text.charAt(q);
    return (
      idStartsAt(q) ||
      c === "*" ||
      c === "[" ||
      c === "#" ||
      c === '"' ||
      c === "'" ||
      isDigit(text.charCodeAt(q))
    );
  };

  /** Opens a `{` in code. */
  const openBrace = () => {
    const f = top;
    const start = pos;
    const head = f.head;
    let kind = F_BLOCK;
    let flags = 0;
    if (head !== null && (head.kind === H_CLASS || head.kind === H_INTERFACE)) {
      f.head = null;
      if (head.kind === H_INTERFACE) {
        punct("{");
        push(openTyped(F_TYPE_BRACE, R_INTERFACE, T_AFTER));
        return;
      }
      kind = F_CLASS;
      if (head.expr) flags = B_ENDS_EXPR;
    } else if (f.body !== 0) {
      if (f.body === 2) flags = B_ENDS_EXPR;
    } else if (prevPunct === "=>") {
      kind = F_BLOCK;
    } else if (state === EXPR) {
      kind = F_OBJECT;
      if (f.decl === D_BINDING) flags = B_DECL_PATTERN;
    }
    f.head = null;
    f.body = 0;
    punct("{");
    const g = frame(kind, start);
    g.flags = flags;
    push(g);
    settle(kind === F_OBJECT ? EXPR : START, "", "{");
  };

  /** Closes a `}` in code. */
  const closeBrace = () => {
    const f = top;
    if (f.kind === F_TEMPLATE) {
      pop();
      template(false, f.tagged, false);
      return;
    }
    if (f.kind !== F_BLOCK && f.kind !== F_CLASS && f.kind !== F_OBJECT && f.kind !== F_JSX_EXPR) {
      mismatch("}", f);
    }
    punct("}", f.kind === F_JSX_EXPR);
    pop();
    if (f.kind === F_JSX_EXPR) return;
    const parent = top;
    if (f.kind === F_OBJECT) {
      settle(END, "", "");
      if ((f.flags & B_DECL_PATTERN) !== 0 && parent.decl === D_BINDING) parent.decl = D_AFTER;
      return;
    }
    settle((f.flags & B_ENDS_EXPR) !== 0 ? END : START, "", "}");
  };

  /** Opens a `(` in code. */
  const openParen = () => {
    const f = top;
    const g = frame(F_PAREN, pos);
    if (forPending) g.flags |= P_FOR | P_KEYWORD;
    else if (PAREN_KEYWORDS.has(prevWord)) g.flags |= P_KEYWORD;
    if (f.head !== null && f.head.kind === H_FN) {
      g.flags |= P_FN_PARAMS;
      if (f.head.expr) g.flags |= P_FN_EXPR;
    }
    if (deco === 1 || deco === 2) {
      g.flags |= P_DECORATOR;
      if (decoAtStart) g.flags |= P_DECORATOR_AT_START;
      deco = 0;
    }
    f.head = null;
    forPending = false;
    punct("(");
    push(g);
    settle(EXPR, "", "(");
  };

  /** Closes a `)` in code. */
  const closeParen = () => {
    const f = top;
    if (f.kind !== F_PAREN) mismatch(")", f);
    punct(")");
    pop();
    if ((f.flags & P_FN_PARAMS) !== 0) top.body = (f.flags & P_FN_EXPR) !== 0 ? 2 : 1;
    if ((f.flags & P_KEYWORD) !== 0) {
      settle(START, "", ")");
      return;
    }
    if ((f.flags & P_DECORATOR_AT_START) !== 0) {
      settle(START, "", ")");
      return;
    }
    settle(END, "", ")");
    closedParen = (f.flags & P_DECORATOR) === 0;
  };

  /** Reads a `:` in code. */
  const colon = () => {
    const f = top;
    const afterParen = closedParen;
    punct(":");
    if (f.ternary > 0) {
      f.ternary--;
      settle(EXPR, "", ":");
      return;
    }
    if ((f.kind === F_TOP || f.kind === F_BLOCK) && f.cases > 0) {
      f.cases--;
      settle(START, "", ":");
      return;
    }
    if (afterParen) {
      settle(EXPR, "", ":");
      startType(T_ANNOTATION);
      return;
    }
    switch (f.kind) {
      case F_CLASS:
      case F_PAREN:
      case F_BRACKET:
        settle(EXPR, "", ":");
        startType(T_ANNOTATION);
        return;
      case F_TOP:
      case F_BLOCK:
        if (f.decl === D_AFTER) {
          settle(EXPR, "", ":");
          startType(T_ANNOTATION);
          return;
        }
        settle(START, "", ":");
        return;
      default:
        settle(EXPR, "", ":");
    }
  };

  /** Reads a `?` in code: a conditional's, or an optional member's or parameter's marker. */
  const question = () => {
    const optional = memberKey;
    punct("?");
    let marker = optional;
    if (!marker) {
      const p = peek(pos);
      const c = text.charAt(p);
      marker =
        c === ":" ||
        c === ")" ||
        c === "," ||
        (c === "=" && text.charAt(p + 1) !== "=" && text.charAt(p + 1) !== ">");
    }
    if (!marker) top.ternary++;
    settle(EXPR, "", "?");
  };

  /** Reads a `<` in code. */
  const lessThan = () => {
    if (text.startsWith("<!--", pos)) {
      fail(pos, "an HTML-like comment, which a script and a module read differently");
    }
    const head = top.head;
    // Type parameters or arguments: after a member's key (`m<T>()`), after `?.` (`f?.<T>()`), and
    // in a function, class, interface or alias head.
    if (
      memberKey ||
      prevPunct === "?." ||
      (head !== null && (head.kind !== H_ALIAS || head.named))
    ) {
      const angle = openTyped(F_TYPE_ANGLE, R_PARAMS, T_AFTER);
      punct("<");
      push(angle);
      return;
    }
    if (state === END) {
      const value = punctuator();
      punct(value);
      settle(EXPR, "", value);
      return;
    }
    // Where an expression starts: a type assertion or a generic arrow function's type parameters
    // (TypeScript), or JSX.
    if (!jsx || genericArrowAt()) {
      const angle = openTyped(F_TYPE_ANGLE, R_ASSERT, T_AFTER);
      punct("<");
      push(angle);
      return;
    }
    openJsx();
  };

  /**
   * Reads one token in code.
   * @param {number} c the character at `pos`
   */
  const codeToken = (c) => {
    const f = top;
    if (newline && RESTRICTED_WORDS.has(prevWord)) {
      state = START;
      declPos = true;
    }
    // A pending function body survives only its return type; a head, only its own parts.
    if (f.body !== 0 && c !== 123 && c !== 58) f.body = 0;
    const head = f.head;
    if (head !== null) {
      const goesOn =
        head.kind === H_FN
          ? c === 42 || c === 60 || c === 40 || idStartsAt(pos)
          : head.kind === H_ALIAS
            ? c === 60 || c === 61 || idStartsAt(pos)
            : c !== 59 && c !== 41 && c !== 93 && c !== 125;
      if (!goesOn) f.head = null;
    }
    if (deco === 2 && c !== 46 && c !== 40) {
      // The decorator ended: what it decorates follows.
      deco = 0;
      if (decoAtStart) {
        state = START;
        declPos = true;
      }
    }
    if (c === 34 || c === 39) {
      const key = memberPosition();
      string();
      settle(END, "", "");
      memberKey = key;
      return;
    }
    if (c === 96) {
      template(false, state === END, false);
      return;
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(pos + 1)))) {
      const key = memberPosition();
      number();
      settle(END, "", "");
      memberKey = key;
      return;
    }
    if (idStartsAt(pos)) {
      name(pos);
      return;
    }
    if (c === 35) {
      const key = memberPosition();
      const start = pos;
      pos++;
      if (!idStartsAt(pos)) fail(start, "a `#` that starts no private name");
      const { value } = identifier();
      emit("private-name", start, pos, `#${value}`);
      settle(END, "", "");
      memberKey = key;
      return;
    }
    if (c === 47 && state !== END) {
      regex();
      settle(END, "", "");
      return;
    }
    if (c === 60 || c === 61 || c === 62 || c === 124) conflictMarker();
    switch (c) {
      case 123:
        openBrace();
        return;
      case 125:
        closeBrace();
        return;
      case 40:
        openParen();
        return;
      case 41:
        closeParen();
        return;
      case 91: {
        const g = frame(F_BRACKET, pos);
        if (memberPosition()) g.flags |= B_COMPUTED_KEY;
        if (f.decl === D_BINDING) g.flags |= B_DECL_PATTERN;
        punct("[");
        push(g);
        settle(EXPR, "", "[");
        return;
      }
      case 93: {
        if (f.kind !== F_BRACKET) mismatch("]", f);
        punct("]");
        pop();
        settle(END, "", "]");
        if ((f.flags & B_COMPUTED_KEY) !== 0) memberKey = true;
        if ((f.flags & B_DECL_PATTERN) !== 0 && top.decl === D_BINDING) top.decl = D_AFTER;
        return;
      }
      case 58:
        colon();
        return;
      case 63:
        if (
          text.charCodeAt(pos + 1) !== 63 &&
          !(text.charCodeAt(pos + 1) === 46 && !isDigit(text.charCodeAt(pos + 2)))
        ) {
          question();
          return;
        }
        break;
      case 60:
        lessThan();
        return;
      case 64:
        punct("@");
        deco = 1;
        decoAtStart = state === START || memberPosition();
        settle(EXPR, "", "@");
        return;
      default:
        break;
    }
    const value = punctuator();
    if (value === "") fail(pos, `a character that cannot stand in code (U+${hex(c)})`);
    if (value === "--" && text.charCodeAt(pos + 2) === 62 && (newline || !significant)) {
      fail(pos, "an HTML-like comment, which a script and a module read differently");
    }
    const postfix = state === END && !newline;
    punct(value);
    switch (value) {
      case "++":
      case "--":
      case "!":
        settle(postfix ? END : EXPR, "", value);
        return;
      case ";":
        f.ternary = 0;
        f.cases = 0;
        f.decl = D_NONE;
        f.head = null;
        f.body = 0;
        settle(
          f.kind === F_TOP || f.kind === F_BLOCK || f.kind === F_CLASS ? START : EXPR,
          "",
          ";",
        );
        return;
      case ",":
        if (f.decl === D_AFTER || f.decl === D_INIT) f.decl = D_BINDING;
        settle(EXPR, "", ",");
        return;
      case "=":
        if (f.decl === D_AFTER) f.decl = D_INIT;
        if (f.head !== null && f.head.kind === H_ALIAS && f.head.named) {
          f.head = null;
          settle(EXPR, "", "=");
          startType(T_ANNOTATION);
          return;
        }
        settle(EXPR, "", "=");
        return;
      case ".":
      case "?.":
        settle(EXPR, "", value);
        afterDot = true;
        if (deco === 2) deco = 3;
        return;
      case "*":
        if (memberPosition()) {
          settle(EXPR, "", "*");
          memberMod = true;
          return;
        }
        settle(EXPR, "", "*");
        return;
      default:
        settle(EXPR, "", value);
    }
  };

  // --- The loop ---------------------------------------------------------------------------------

  if (text.charCodeAt(0) === 35 && text.charCodeAt(1) === 33) {
    while (pos < n && !isLineTerminator(text.charCodeAt(pos))) pos++;
    emit("hashbang", 0, pos, text.slice(2, pos));
  }
  for (;;) {
    const f = top;
    if (f.kind === F_JSX) {
      if (f.phase === J_CHILDREN) jsxChildren();
      else jsxTag();
      continue;
    }
    skipTrivia();
    if (pos >= n) break;
    const c = text.charCodeAt(pos);
    const tt = f.tt;
    if (tt !== null) {
      if (typeGoesOn(tt, c)) {
        typeToken(c, tt);
        newline = false;
        continue;
      }
      endType();
    }
    if (f.typed) {
      typeToken(c, null);
      newline = false;
      continue;
    }
    codeToken(c);
  }
  if (frames.length > 1) {
    const open = frames[frames.length - 1] ?? top0;
    fail(
      open.start,
      open.kind === F_JSX
        ? `an unterminated JSX element <${open.tag}>`
        : `a bracket left open (expected "${CLOSERS[open.kind]}")`,
    );
  }
  return tokens;
}

/** @param {number} c */
function hex(c) {
  return c.toString(16).toUpperCase().padStart(4, "0");
}
