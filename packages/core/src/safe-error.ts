// safeError (spec 08 §5.4): what may be kept of anything thrown. The class name, a bounded code and
// the stack frames' file, line and column survive; the message survives only for a FinError, whose
// message is Fin's own words. Nothing thrown is ever logged whole.
//
// A V8 stack is the error's header (`Name: message`, or `Name [CODE]: message` for Node's own
// errors) followed by the frames. The message may hold several lines, and a line of it may be
// shaped like a frame, so the header is located by the message's own text and dropped before any
// frame is read; when it cannot be located, no frame is kept.
import { isBoundedCode, isFinError } from "./errors.ts";
import { FRAME_FILE, FRAME_FUNCTION, scrubText, WITHHELD } from "./scrub.ts";

export interface SafeFrame {
  file: string;
  line: number;
  column?: number;
  fn?: string;
}

export interface SafeError {
  errorName: string;
  errorCode: string;
  message?: string;
  frames: SafeFrame[];
}

const MAX_FRAMES = 20;
/** A frame line longer than this is not one V8 wrote (Sentry's parser has the same cut). */
const MAX_FRAME_LINE = 1024;
const NODE_CODE = /^(?:E[A-Z0-9_]{2,40}|ERR_[A-Z0-9_]{2,60})$/;
const NAME = /^[A-Za-z_$][\w$]{0,63}$/;
// V8's frame lines: "    at fn (location)" or "    at location", where location ends in
// ":line:column" (or ":line").
const FRAME_WITH_FN = /^\s*at (.+?) \((.+)\)$/;
const FRAME_BARE = /^\s*at (.+)$/;
const LOCATION = /^(.+?):(\d+)(?::(\d+))?$/;

function frameOf(line: string): SafeFrame | undefined {
  if (line.length > MAX_FRAME_LINE) return undefined;
  const withFn = FRAME_WITH_FN.exec(line);
  const location = withFn?.[2] ?? FRAME_BARE.exec(line)?.[1];
  if (location === undefined) return undefined;
  const parts = LOCATION.exec(location);
  if (parts?.[1] === undefined || parts[2] === undefined) return undefined;
  // A location is a path, a `node:` name or a URL; anything else did not come from V8.
  if (!FRAME_FILE.test(parts[1])) return undefined;
  const frame: SafeFrame = { file: scrubText(parts[1]).slice(0, 300), line: Number(parts[2]) };
  if (parts[3] !== undefined) frame.column = Number(parts[3]);
  const fn = withFn?.[1];
  if (fn !== undefined && FRAME_FUNCTION.test(fn)) frame.fn = fn;
  return frame;
}

function nameOf(error: unknown): string {
  if (error instanceof Error) {
    const ctor = error.constructor?.name;
    if (typeof ctor === "string" && NAME.test(ctor)) return ctor;
    return NAME.test(error.name) ? error.name : "Error";
  }
  if (error === null) return "null";
  return typeof error;
}

function textOf(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value ?? "");
  } catch {
    return "";
  }
}

/**
 * The lines of an error's stack after its header, or none when the header cannot be found (the
 * message changed after the stack was written, or the stack was replaced).
 */
export function stackFrameLines(error: Error): string[] {
  const stack = textOf(error.stack);
  if (stack === "") return [];
  const message = textOf(error.message);
  const name = textOf(error.name);
  let end: number;
  if (message === "") {
    // The header is the name alone (with a Node code), on its own line or lines.
    if (!name.includes("\n")) end = stack.indexOf("\n");
    else if (stack.startsWith(name)) end = name.length;
    else return [];
  } else {
    // `Name: message` or `Name [CODE]: message`: one line of name, then the whole message; with
    // no name, the message alone.
    const at = stack.indexOf(`: ${message}`);
    if (at !== -1 && !stack.slice(0, at).includes("\n")) end = at + 2 + message.length;
    else if (stack.startsWith(message)) end = message.length;
    else return [];
  }
  if (end === -1 || stack.charAt(end) !== "\n") return [];
  return stack.slice(end + 1).split("\n");
}

/** Reduces anything thrown to the fields a line or a report may carry. */
export function safeError(error: unknown): SafeError {
  const errorName = nameOf(error);
  let errorCode = "unexpected";
  let message: string | undefined;
  if (isFinError(error)) {
    errorCode = error.code;
    message = scrubText(error.message).slice(0, 200);
  } else if (error instanceof Error) {
    const code: unknown = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && (NODE_CODE.test(code) || isBoundedCode(code))) {
      errorCode = code.slice(0, 64);
    }
  }
  const frames: SafeFrame[] = [];
  if (error instanceof Error) {
    for (const line of stackFrameLines(error)) {
      const frame = frameOf(line);
      if (frame !== undefined) frames.push(frame);
      if (frames.length >= MAX_FRAMES) break;
    }
  }
  const out: SafeError = { errorName, errorCode, frames };
  if (message !== undefined) out.message = message;
  return out;
}

/**
 * A stand-in for `error` holding only what safeError keeps, for a reporter that reads the class,
 * the message and the stack itself (Sentry's `captureException`): its name is the class name, its
 * message a FinError's fixed words or "[withheld]", and its stack the kept frames alone.
 */
export function safeException(error: unknown): Error {
  const safe = safeError(error);
  const message = (safe.message ?? WITHHELD).replace(/\s+/g, " ");
  const stand = new Error(message);
  stand.name = safe.errorName;
  const lines = safe.frames.map((frame) => {
    const location = `${frame.file}:${frame.line}${frame.column !== undefined ? `:${frame.column}` : ""}`;
    return frame.fn !== undefined ? `    at ${frame.fn} (${location})` : `    at ${location}`;
  });
  Object.defineProperty(stand, "stack", {
    value: [`${stand.name}: ${message}`, ...lines].join("\n"),
    configurable: true,
    writable: true,
  });
  return stand;
}
