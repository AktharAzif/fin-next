// safeError (spec 08 §5.4): what may be kept of anything thrown. The class name, a bounded code and
// the stack frames' file, line and column survive; the message survives only for a FinError, whose
// message is Fin's own words. Nothing thrown is ever logged whole.
import { isBoundedCode, isFinError } from "./errors.ts";
import { scrubText } from "./scrub.ts";

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
const NODE_CODE = /^(?:E[A-Z0-9_]{2,40}|ERR_[A-Z0-9_]{2,60})$/;
const NAME = /^[A-Za-z_$][\w$]{0,63}$/;
// V8's frame lines: "    at fn (location)" or "    at location", where location ends in
// ":line:column" (or ":line").
const FRAME_WITH_FN = /^\s*at (.+?) \((.+)\)$/;
const FRAME_BARE = /^\s*at (.+)$/;
const LOCATION = /^(.+?):(\d+)(?::(\d+))?$/;
const FN_NAME = /^(?:async |new )?[A-Za-z_$<][\w$.<>[\] ]{0,119}$/;

function frameOf(line: string): SafeFrame | undefined {
  const withFn = FRAME_WITH_FN.exec(line);
  const location = withFn?.[2] ?? FRAME_BARE.exec(line)?.[1];
  if (location === undefined) return undefined;
  const parts = LOCATION.exec(location);
  if (parts?.[1] === undefined || parts[2] === undefined) return undefined;
  const frame: SafeFrame = { file: scrubText(parts[1]).slice(0, 300), line: Number(parts[2]) };
  if (parts[3] !== undefined) frame.column = Number(parts[3]);
  const fn = withFn?.[1];
  if (fn !== undefined && FN_NAME.test(fn)) frame.fn = fn;
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
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  for (const line of stack.split("\n").slice(1)) {
    const frame = frameOf(line);
    if (frame !== undefined) frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  const out: SafeError = { errorName, errorCode, frames };
  if (message !== undefined) out.message = message;
  return out;
}
