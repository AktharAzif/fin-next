// Strict JSON for every file the engine reads (spec 07 §3.5: configuration, spool requests,
// receipts; §2.3.1: package manifests and tools/layout.json).
//
// JSON.parse keeps the last of two equal keys, so `{"model":"opus","model":"fable"}` would read as
// fable with no trace. This parser refuses a repeated key instead, returns objects with a null
// prototype (so `__proto__`, `constructor` and `prototype` are plain own keys and never reach
// Object.prototype), caps nesting, and refuses a byte order mark and any trailing text.

import { readFileSync, statSync } from "node:fs";
import { escapeText, shownText } from "./display.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonParseResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: string; duplicateKey?: { path: string; key: string } };

const DEFAULT_MAX_DEPTH = 64;
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class JsonSyntaxError extends Error {
  readonly duplicateKey: { path: string; key: string } | undefined;
  constructor(message: string, duplicateKey?: { path: string; key: string }) {
    super(message);
    this.duplicateKey = duplicateKey;
  }
}

/** Parses `text` as strict JSON. Never throws. */
export function parseJsonStrict(
  text: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): JsonParseResult {
  const parser = new Parser(text, maxDepth);
  try {
    const value = parser.parseDocument();
    return { ok: true, value };
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return error.duplicateKey === undefined
        ? { ok: false, error: error.message }
        : { ok: false, error: error.message, duplicateKey: error.duplicateKey };
    }
    throw error;
  }
}

/** True for a JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The own keys of an object: its enumerable string keys, then its symbol keys, so a caller can
 * refuse a key it does not know. A parsed JSON object has only the first kind. (This code loads
 * modules only by import, so Reflect and the property-descriptor functions are refused here:
 * scripts/import-rules.mjs.)
 */
export function ownKeys(value: object): Array<string | symbol> {
  return [...Object.keys(value), ...Object.getOwnPropertySymbols(value)];
}

export type JsonFileResult =
  | { ok: true; value: JsonValue }
  | { ok: false; missing: boolean; error: string };

/** Reads and strictly parses a JSON file of at most `maxBytes`. Never throws for I/O. */
export function readJsonFile(path: string, maxBytes: number): JsonFileResult {
  let bytes: Buffer;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return { ok: false, missing: false, error: "not a regular file" };
    if (stats.size > maxBytes) {
      return { ok: false, missing: false, error: `larger than ${maxBytes} bytes` };
    }
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { ok: false, missing: true, error: "missing" };
    return { ok: false, missing: false, error: `cannot be read (${String(code ?? "error")})` };
  }
  return parseJsonBytes(bytes);
}

/** Decodes UTF-8 (refusing invalid sequences) and strictly parses the result. */
export function parseJsonBytes(bytes: Uint8Array): JsonFileResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, missing: false, error: "not valid UTF-8" };
  }
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) return { ok: false, missing: false, error: `not valid JSON: ${parsed.error}` };
  return { ok: true, value: parsed.value };
}

class Parser {
  private readonly text: string;
  private readonly maxDepth: number;
  private pos = 0;

  constructor(text: string, maxDepth: number) {
    this.text = text;
    this.maxDepth = maxDepth;
  }

  parseDocument(): JsonValue {
    if (this.text.charCodeAt(0) === 0xfeff) this.fail("a byte order mark is not allowed");
    this.skipWhitespace();
    const value = this.parseValue(0, "$");
    this.skipWhitespace();
    if (this.pos !== this.text.length) this.fail("unexpected text after the value");
    return value;
  }

  private fail(message: string): never {
    throw new JsonSyntaxError(`${message} at offset ${this.pos}`);
  }

  private skipWhitespace(): void {
    const text = this.text;
    while (this.pos < text.length) {
      const c = text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  private parseValue(depth: number, path: string): JsonValue {
    const c = this.text[this.pos];
    switch (c) {
      case "{":
        return this.parseObject(depth, path);
      case "[":
        return this.parseArray(depth, path);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber();
        return this.fail(c === undefined ? "unexpected end of input" : "unexpected character");
    }
  }

  private parseLiteral<T extends JsonValue>(word: string, value: T): T {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    return this.fail("invalid literal");
  }

  private parseNumber(): number {
    NUMBER_RE.lastIndex = this.pos;
    const match = NUMBER_RE.exec(this.text);
    if (match === null) return this.fail("invalid number");
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("number out of range");
    this.pos += match[0].length;
    return value;
  }

  private parseString(): string {
    const text = this.text;
    this.pos++; // opening quote
    let out = "";
    let start = this.pos;
    while (true) {
      if (this.pos >= text.length) this.fail("unterminated string");
      const c = text.charCodeAt(this.pos);
      if (c === 0x22) {
        out += text.slice(start, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) this.fail("a control character must be escaped in a string");
      if (c === 0x5c) {
        out += text.slice(start, this.pos);
        this.pos++;
        const e = text[this.pos];
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(this.pos + 1, this.pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid unicode escape");
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            this.fail("invalid escape");
        }
        this.pos++;
        start = this.pos;
        continue;
      }
      this.pos++;
    }
  }

  private parseArray(depth: number, path: string): JsonValue[] {
    if (depth >= this.maxDepth) this.fail(`nesting deeper than ${this.maxDepth}`);
    this.pos++; // [
    const out: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return out;
    }
    while (true) {
      this.skipWhitespace();
      out.push(this.parseValue(depth + 1, `${path}[${out.length}]`));
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return out;
      }
      this.fail("expected , or ] in an array");
    }
  }

  private parseObject(depth: number, path: string): JsonObject {
    if (depth >= this.maxDepth) this.fail(`nesting deeper than ${this.maxDepth}`);
    this.pos++; // {
    const out = Object.create(null) as JsonObject;
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return out;
    }
    while (true) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') this.fail("expected a string key in an object");
      const key = this.parseString();
      if (seen.has(key)) {
        // The message escapes the key and the path, which come from the file being read; the
        // structured field keeps them as they are.
        throw new JsonSyntaxError(
          `duplicate key ${shownText(key, 120)} in ${escapeText(path, 240)}`,
          { path, key },
        );
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") this.fail("expected : after an object key");
      this.pos++;
      this.skipWhitespace();
      const value = this.parseValue(depth + 1, `${path}.${key}`);
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return out;
      }
      this.fail("expected , or } in an object");
    }
  }
}
