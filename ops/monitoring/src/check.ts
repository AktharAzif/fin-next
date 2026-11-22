// monitoring:check (spec 08 §7.11; ARCHITECTURE §10.11): the rules over ops/monitoring/<env>/ and
// the catalogue, with no network, in well under a second. It fails when:
//   MC-00 a file is missing or malformed, an alert has an unexpanded placeholder, or a metric's
//         type is not one of Better Stack's;
//   MC-01 an event written in code (any telemetry writer's line, read from the file's tokens; see
//         eventsInCode) is missing from the catalogue, a telemetry writer is passed a name the
//         scan cannot read or one out of the event-name shape, the tokenizer cannot read a file
//         of the code, a catalogue entry is listed twice, or one of spec 01 §8.9's Phase 0
//         events is missing;
//   MC-02 a failure, security or money entry has no alert, no owed alert and no noAlert reason;
//   MC-03 an entry redeclares an envelope field, or a reason code breaks the ReasonCode shape;
//   MC-04 an alert reads an event or field the catalogue does not declare, a catalogue entry names
//         an alert no fragment defines (or an alert watches an event whose entry does not name
//         it), an alert's query cannot be rendered, a security event is filtered with
//         `eq: false` (a line without the field would never alert; `notEq: true` fails closed),
//         or an alert groups an event by other fields than the entry's seriesBy (the watcher's
//         check, target and detail: a failure that stands must never hide a later one);
//   MC-05 one of spec 01 §8.5's heartbeats, or the one the watcher's settings ping, is missing;
//   MC-06 a metric label is ID-shaped or free text;
//   MC-07 a source has no Errors application and no written reason, a file names a source
//         that does not exist, or a secret is delivered to anything but a Railway service of
//         spec 01 §6.2;
//   MC-08 an alert lacks incident_cause, metadata.check, metadata.flow or metadata.runbook, or a
//         runbook (an alert's, a monitor's or a heartbeat's) does not exist;
//   MC-10 a runbook lacks one of Phase 0's headings, or does not name an alert that points at it;
//   MC-11 a threshold, window, minimum count or grace is a literal number instead of an overlay
//         key;
//   MC-12 any file of the environment, the catalogue, the runbooks or the watcher's settings holds
//         a Better Stack identifier, ingest host, DSN or heartbeat URL;
//   MC-13 a staging object names a production policy, or the files name another environment's
//         team (`fin-<env>`), environment or name prefix (`fin-next-<env>-`);
//   MC-14 an alert name is used twice;
//   MC-15 an alert name the code (see alertsInCode) or the catalogue (an entry's owed, any
//         alert-shaped word of a noAlert reason, or a fragment file's text read as code is read and
//         in the form `<name> (P|N, …)`) gives is neither a rule of the environment nor listed in
//         catalog/owed.ts; an owed alert has no lane, no due date or no fragment, is listed twice,
//         or is a rule of the environment already (in owed.ts or in an entry's owed);
//   RT-01 an alert, monitor or heartbeat has no policy, or a staging one names anything but
//         staging-quiet, or names a policy the files do not define;
//   RT-02 staging-quiet is not email only: a severity that calls, texts, pushes or sends critical
//         alerts, an escalation (a repeat or a second step), an ai_sre member, or a step that
//         waits or reaches anyone but the entire staging team (spec 08 §7.9);
//   RT-03 any staging object asks for a call, an SMS, a push or a critical alert itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Token, TokenizeError, tokenize } from "../../../scripts/js-tokens.mjs";
import { fragments as defaultFragments } from "../catalog/index.ts";
import { OWED_ALERTS, type OwedAlert } from "../catalog/owed.ts";
import { type CatalogEntry, ENVELOPE_FIELDS, kindsOf } from "../catalog/types.ts";
import {
  type AlertDef,
  type EnvConfig,
  type Finding,
  loadEnv,
  type Notify,
  overlayKeys,
} from "./config.ts";
import {
  QueryError,
  queryConditions,
  queryEvents,
  queryFields,
  renderSql,
  seriesFields,
} from "./sql.ts";

/** Spec 01 §8.9: every event Phase 0 writes. platform.ts must hold each one. */
export const PHASE0_EVENTS: readonly string[] = [
  "request",
  "process.start",
  "process.health",
  "shutdown.started",
  "shutdown.done",
  "shutdown.forced",
  "process.uncaught_exception",
  "process.unhandled_rejection",
  "background.failed",
  "database.pool_error",
  "dns.lookup_failed",
  "connector.state",
  "connector.health",
  "connector.exited",
  "ingress.untrusted_peer",
  "csrf.refused",
  "api.outside_request",
  "caller.signature_invalid",
  "telemetry.ship_failed",
  "telemetry.recovered",
  "error.unexpected",
  "migrate.started",
  "migrate.done",
  "migrate.failed",
  "task.done",
  "task.failed",
  "job.run",
  "email.sent",
  "email.send_failed",
  "csp.report",
  "watcher.run",
  "watcher.check_failed",
  "deploy.started",
  "deploy.step",
  "deploy.done",
  "deploy.failed",
  "run.registered",
  "run.done",
];

/** Spec 01 §8.5: every heartbeat Phase 0 has. heartbeats.json must hold each one (MC-05). */
export const PHASE0_HEARTBEATS: readonly string[] = [
  "watcher",
  "scheduler-worker",
  "scheduler-payments",
  "email-delivery-check",
  "backup-nightly",
  "backup-hourly",
  "verify-daily",
];

/** Spec 01 §6.2: the Railway services, the only places a secret is delivered to (MC-07). */
export const RAILWAY_SERVICES: readonly string[] = [
  "cloudflared-public",
  "cloudflared-admin",
  "cloudflared-public-b",
  "cloudflared-admin-b",
  "edge",
  "api",
  "worker",
  "payments",
  "console",
  "admin",
  "verify",
  "migrate",
  "backup",
  "cloudflared-db",
];

/** Better Stack's logs-to-metrics types. */
export const METRIC_TYPES: readonly string[] = [
  "string_low_cardinality",
  "int64_delta",
  "float64_delta",
  "datetime64_delta",
  "boolean",
];

/** The headings every Phase 0 runbook has (spec 01 §8.7: short runbooks). */
export const RUNBOOK_HEADINGS: readonly string[] = [
  "## What it means",
  "## First check",
  "## Containment",
  "## When to wake the owner",
];

const QUIET_POLICY = "staging-quiet";
const REASON_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
const FLOW_ID = /^F(?:\d{1,2}|-[a-z0-9-]+)$/;
const THRESHOLD = /^@(?:any|none|thresholds\.[a-z0-9][a-z0-9-]*)$/;
const ID_SHAPED_FIELD = /(?:Id|ID|_id)$|^(?:cfRay|dt|message|replica|release|detail|target|runId)$/;
const NOTIFY_KEYS = ["sms", "call", "push", "critical_alert"] as const;
const CODE_DIRS = ["apps", "packages", "ops", "tools"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage", "test", "fixtures"]);

/** Better Stack identifiers, ingest hosts, DSNs and heartbeat URLs (MC-12). */
const IDENTIFIER_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: "ingest host", pattern: /betterstackdata\.com/i },
  { name: "heartbeat URL", pattern: /\/api\/v\d+\/heartbeat\//i },
  { name: "DSN", pattern: /https?:\/\/[A-Za-z0-9]{8,}@/ },
  { name: "team ID", pattern: /(?<![A-Za-z0-9])t\d{4,}(?![A-Za-z0-9])/ },
  {
    name: "object ID",
    pattern:
      /"(?:id|team_id|source_id|policy_id|monitor_id|heartbeat_id|exploration_id|urgency_id|application_id)"\s*:/,
  },
  { name: "token field", pattern: /"(?:token|ingesting_host|url|dsn)"\s*:/ },
];

export interface CheckOptions {
  readonly envs?: readonly string[];
  readonly fragments?: Readonly<Record<string, readonly CatalogEntry[]>>;
  /** The owed alerts (MC-15); catalog/owed.ts's by default. */
  readonly owed?: readonly OwedAlert[];
  /** Extra files scanned for MC-12, relative to root (directories are walked). */
  readonly scan?: readonly string[];
  /**
   * Whether to scan the repository's code for the events its telemetry writers write (MC-01) and
   * the alerts it names (MC-15).
   */
  readonly scanCode?: boolean;
}

function walk(root: string, dir: string, out: string[]): void {
  const full = join(root, dir);
  if (!existsSync(full)) return;
  for (const name of readdirSync(full)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

// MC-01's scan: the events the code writes, in TypeScript outside tests. It reads each file as the
// shared tokenizer (scripts/js-tokens.mjs) gives it: its rules match token sequences and literal
// values (a string's decoded value, a template's static parts), never the raw text, so a comment, a
// string, a regular expression or JSX text is never read as code, and code is never read as one of
// them. Fin writes a telemetry line in three ways, and the scan reads each:
//   1. a writer method called with the event's name first: `log("x.y", …)` (the watcher's own),
//      `telemetry.log|logUnit|logLocal("x.y", …)` (packages/server), `lines.write("x.y", …)` (the
//      identity, staff and orgs line port; fin-review's local lines), `run.line("x.y", …)` and
//      `this.line` (ops/fin's run), `this.format("x.y", …)` (the transport's own line);
//   2. a writer method called with an object that names the event, wherever its `event` key
//      stands in it: `log.write({ event: "x.y", … })` (the unit of work's writer);
//   3. a raw line: an `event: "x.y"` property anywhere inside `JSON.stringify(…)` (a process that
//      writes before its telemetry exists: config.invalid, process.mode_refused, migrate's config
//      failure; tools/static-deploy's lines), its value a string literal.
// The writer methods are log, logUnit, logLocal, line, write and format (private `#` ones too), a
// name followed by `(` or `?.(`. A call's writer is the name before the method's dot (`rt.lines.
// write` is `lines`, `this.o.log.log` is `log`, `deps.lines!.write` is `lines`), or the function
// itself for a bare call (`log("x.y")` is `log`). A name is read decoded (`lines` is `lines`).
//
// A telemetry writer is one of `lines`, `log`, `telemetry`, `run`, or `this` (a writer's call on
// itself), or a method the file itself declares as an adapter: a function, method or property
// named as a writer method whose first parameter a telemetry writer's call in its body is passed
// (`const line = (event, fields) => run.line(event, "error", fields)`, `write: (event) =>
// lines.write(event, …)`, an adapter of such an adapter). A call of an adapter's name is read as a
// telemetry writer's whatever its receiver (`line(…)`, `sink.write(…)`), so a name it cannot read
// there is a finding. Through any other writer a call counts only with a name its first argument
// holds as literals: a string, an object's literal `event`, or strings joined by a ternary, `||`,
// `??` or `&&` (each one counts). One rule drops even that: a name of one word, with no dot. That
// drops ops/fin's stream writer, `write("stdout", …)` and `write("stderr", …)`, and CSS's
// `format("woff2")` in the token generator. It cannot hide a real event: every event Fin writes is
// `<area>.<name>`, with a dot, except spec 01 §8.9's `request`, and a dotted name counts through
// any writer; `request` is written only through telemetry writers (`telemetry.log`,
// `lines.write`), and PHASE0_EVENTS makes the catalogue hold it whatever the scan finds.
//
// A telemetry writer's first argument is read whole, and gives names, no name, or an MC-01
// finding ("cannot read": write the event's name as a literal; "out of the event-name shape": the
// line would ship as telemetry.bad_event, which no alert watches):
//   - a string literal, or strings joined by a ternary, `||`, `??` or `&&`, gives each string,
//     and each must have the event-name shape (lower case, dotted: `<area>.<name>`). A message
//     gives no name, but only through `this` or a bare call (ops/fin's printer,
//     `this.#line("warning: ", text)`; tools/static-deploy's `log(…)`): a string that is empty or
//     holds white space, a newline or a tab written as an escape included (a name never does).
//     Through a member call (on `lines`, `log`, `telemetry`, `run`, or an adapter's receiver) a
//     message is a finding, and so is, through any writer, a string of another shape
//     (`"step-up-locked"`, `"deployFailed"`, `"edge.sign-in"`) or names beside messages;
//   - an object literal gives its own `event` key's value, read as above, where a message too is
//     a finding; no `event` key, a spread after it, or a value that is not a literal, is a finding;
//   - a variable, or its `.event` (`lines.write(event, …)`, `log.write(line)`,
//     `telemetry.log(line.event, …)`), is read from the declaration that binds it where the call
//     stands: searched in the whole file, above or below the call, by its scope (a block, a
//     function's parameters, the module). Every declarator of a declaration binds, and so does
//     every name a pattern binds (a renamed one, `{ name: event }`, included). A binding is read
//     when it is a `const`, or a `let` or `var` the file never assigns again, whose value is read as
//     above (an object whose `event` is never assigned again), or a `for (const x of [...])` over
//     strings; a value that is no event name, a message included, is a finding. Assigning again is
//     `=`, a compound assignment, `++` or `--`, a destructuring assignment that holds the name, or a
//     `for … of` or `for … in` head that does. A parameter gives no name only as a forwarding
//     adapter's: the first parameter of a function, method or property named as a writer method
//     (`write: (event, level, fields) => telemetry.log(event, …)`, packages/server's `log(event, …)
//     { this.format(event, …) }`), with no default and never assigned again in the function, whose
//     callers' names the scan reads where they call it. Any other binding is a finding: an import,
//     a `this.` or `#` member, any other parameter (a helper's, a callback's, one with a default),
//     a destructured or `for … in` one, `let x;`, a `let` assigned again, an object whose `event`
//     is assigned again, any member but `.event`, or a name the file never binds;
//   - anything else is a name built at run time (`` `switch.${state}` ``, `"switch." + state`, a
//     call, `name ?? "x.y"`, a ternary with a branch that is not a string) and is a finding, but
//     for a message through `this` or a bare call: a template, or a `+` join with no alternatives
//     in it, whose static part (a template's text outside every `${…}`) holds white space;
//   - a parameter list (`log(event: string, …)`, a method's own) is a declaration, not a call.
// Which `(` opens a function's parameters is read from the tokens around it: after `function` or a
// function's name, or after a method's name that starts a member (after `{`, `}`, `,`, `;`, `*` or a
// modifier such as `async`, `get` or `static`), with a `{` body after it; anywhere else, with an
// arrow's `=>` after it (a return type may stand before either). A `(` after any other name, a
// member's (`x.write(`) included, is a call's, and `if`, `for`, `while`, `switch` and `catch` heads
// are no function's.
//
// A file the tokenizer cannot read (a string, template, comment, regular expression or JSX element
// left open, brackets or JSX tags that do not pair, an invalid escape or number, an HTML-like
// comment, a conflict marker, a character that cannot stand in code) is an MC-01 finding that names
// the file and the place, and none of its calls is read: every file the scan reads is tokenized,
// and none is skipped because it cannot be read.
//
// What the tokens alone cannot decide is a review finding, as for imports:check (BD-19): a writer
// reached under a name that is no writer method's (an alias such as `const emit = lines.write`, a
// receiver that is no name such as `getLines().write`, a computed key such as `lines[method](…)`),
// and an adapter that another file declares, called there through a receiver that is no telemetry
// writer's; a name computed at run time that no literal in the file holds whole (a concatenation
// of variables, a computed key, a call's result: through a telemetry writer such a call is a
// finding, but what it computes, and the same through any other writer, is the reviewer's to
// read); an object changed through another reference or by a destructuring assignment; and a raw
// line's `event` that is not a string literal (JSON.stringify builds other things than lines, so
// it is not a finding).
const WRITER_METHODS: ReadonlySet<string> = new Set([
  "log",
  "logUnit",
  "logLocal",
  "line",
  "write",
  "format",
]);
const TELEMETRY_WRITERS: ReadonlySet<string> = new Set([
  "lines",
  "log",
  "telemetry",
  "run",
  "this",
]);
const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
/** Text a message holds and a name never does: white space (a newline or tab, decoded, included). */
const MESSAGE_TEXT = /\s/;
const OPENERS: ReadonlySet<string> = new Set(["(", "[", "{"]);
const CLOSERS: ReadonlySet<string> = new Set([")", "]", "}"]);
const ASSIGNMENTS: ReadonlySet<string> = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
]);
/** Keywords after which a `(` is an expression's: a call's arguments or an arrow's parameters. */
const EXPRESSION_WORDS: ReadonlySet<string> = new Set([
  "async",
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "function",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
/** The statements whose head is a `(`: no function's parameters. */
const CONTROL_WORDS: ReadonlySet<string> = new Set(["catch", "for", "if", "switch", "while"]);
/** The modifiers that may stand before a method's name. */
const MEMBER_MODIFIERS: ReadonlySet<string> = new Set([
  "abstract",
  "accessor",
  "async",
  "declare",
  "get",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "set",
  "static",
]);
/** The punctuators after which a `{` in a return type opens a type literal, not the body. */
const TYPE_LITERAL_AFTER: ReadonlySet<string> = new Set([":", "|", "&", "<", ",", "("]);

/** Where an event is written, and the call that writes it (for MC-01's message). */
export interface CodeEvent {
  readonly file: string;
  readonly line: number;
  readonly call: string;
}

/** A file as the telemetry writers' reader sees it: the tokens of its code (see the rule above). */
interface Source {
  readonly file: string;
  readonly text: string;
  /** The code's tokens in order: comments and a hashbang left out. Every range is of these. */
  readonly tokens: readonly Token[];
  /** Each `(`, `[`, `{` and template head, and the token that closes it. */
  readonly pairs: ReadonlyMap<number, number>;
  /** Each closing token, and the token it closes. */
  readonly openers: ReadonlyMap<number, number>;
  /** Each token's innermost enclosing opener, or -1 at the top level. */
  readonly parents: readonly number[];
  /** The writer calls, found once when first needed. */
  calls?: readonly WriterCall[];
  /** The functions, found once when first needed. */
  functions?: readonly CodeFunction[];
  /** The writer methods the file declares as adapters, found once when first needed. */
  adapters?: ReadonlySet<string>;
  /** Each name's bindings, found once per name. */
  readonly bindings: Map<string, readonly Binding[]>;
  /** Whether each binding's name is assigned again (or its object changed), found once. */
  readonly changed: Map<Binding, boolean>;
}

/** A writer method's call: its name, the `(` of its arguments, and its writer. */
interface WriterCall {
  /** The method's token. */
  readonly at: number;
  /** The `(` that opens its arguments. */
  readonly open: number;
  /** The method's name, without a private name's `#`. */
  readonly method: string;
  /** The method as written: `line` or `#line`. */
  readonly spelled: string;
  /** The name before the method's dot, "" for any other receiver, or undefined for a bare call. */
  readonly receiver: string | undefined;
}

/** A function, method or arrow: its name (or ""), its parameters and its body, as token ranges. */
interface CodeFunction {
  readonly name: string;
  /** Its parameters: `(…)` with the brackets, or an arrow's one parameter. */
  readonly params: readonly [number, number];
  readonly body: readonly [number, number];
}

/** Whether the token is the punctuator `value`, outside JSX markup. */
function isPunct(token: Token | undefined, value: string): boolean {
  return token?.kind === "punct" && token.value === value && token.jsx !== true;
}

/** A name's token; a literal's: a string, or a template literal with no substitution. */
type NameToken = Token & { readonly kind: "name" };
type LiteralToken = Token & { readonly kind: "string" | "template" };

/** Whether the token is a name (an identifier or a keyword) outside JSX markup, `value` if given. */
function isName(token: Token | undefined, value?: string): token is NameToken {
  return (
    token?.kind === "name" && token.jsx !== true && (value === undefined || token.value === value)
  );
}

/** Whether the token is a literal value: a string, or a template literal with no substitution. */
function isLiteral(token: Token | undefined): token is LiteralToken {
  return (token?.kind === "string" || token?.kind === "template") && token.jsx !== true;
}

/** Whether the token is a closer: `)`, `]`, `}`, or a template's middle or tail. */
function isCloser(token: Token | undefined): boolean {
  return (
    (token?.kind === "punct" && CLOSERS.has(token.value)) ||
    token?.kind === "template-middle" ||
    token?.kind === "template-tail"
  );
}

/** Whether the token at `i` is a member's name: after `.` or `?.`. */
function isMember(src: Source, i: number): boolean {
  return isPunct(src.tokens[i - 1], ".") || isPunct(src.tokens[i - 1], "?.");
}

/** Whether the token is a declaration's keyword, `const`, `let` or `var`. */
function isDeclaration(token: Token | undefined): boolean {
  return isName(token, "const") || isName(token, "let") || isName(token, "var");
}

/** A key named `event`: the name, or a string whose value is "event". */
function isEventKey(token: Token | undefined): boolean {
  return isName(token, "event") || (token?.kind === "string" && token.value === "event");
}

/** The tokens of a file's code, and how its brackets pair (the tokenizer refuses any that do not). */
function sourceOf(file: string, text: string): Source {
  const tokens = tokenize(text, file).filter(
    (t) => t.kind !== "line-comment" && t.kind !== "block-comment" && t.kind !== "hashbang",
  );
  const pairs = new Map<number, number>();
  const openers = new Map<number, number>();
  const parents: number[] = [];
  const open: number[] = [];
  for (const [i, t] of tokens.entries()) {
    const bracket = t.kind === "punct" ? t.value : "";
    if (CLOSERS.has(bracket) || t.kind === "template-tail") {
      const at = open.pop() ?? -1;
      pairs.set(at, i);
      openers.set(i, at);
    }
    parents.push(open.at(-1) ?? -1);
    if (OPENERS.has(bracket) || t.kind === "template-head") open.push(i);
  }
  return { file, text, tokens, pairs, openers, parents, bindings: new Map(), changed: new Map() };
}

/** The end of the expression at `from`: the first `,` or `;` outside brackets, or a closer. */
function exprEnd(src: Source, from: number): number {
  const { tokens, pairs } = src;
  for (let i = from; i < tokens.length; i++) {
    const close = pairs.get(i);
    if (close !== undefined) i = close;
    else if (isPunct(tokens[i], ",") || isPunct(tokens[i], ";") || isCloser(tokens[i])) return i;
  }
  return tokens.length;
}

/** [start, end) split at each `,` that stands outside any bracket. */
function commaParts(src: Source, start: number, end: number): [number, number][] {
  const parts: [number, number][] = [];
  let from = start;
  for (let i = start; i < end; i++) {
    const close = src.pairs.get(i);
    if (close !== undefined) i = close;
    else if (isPunct(src.tokens[i], ",")) {
      parts.push([from, i]);
      from = i + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

/** The innermost bracket pair around the token at `at`, as [open, end), or the whole file. */
function enclosing(src: Source, at: number): [number, number] {
  const open = src.parents[at] ?? -1;
  return open < 0 ? [0, src.tokens.length] : [open, (src.pairs.get(open) ?? at) + 1];
}

/** The index of the first `:` outside brackets in [start, end), or undefined. */
function colonIn(src: Source, start: number, end: number): number | undefined {
  for (let i = start; i < end; i++) {
    const close = src.pairs.get(i);
    if (close !== undefined) i = close;
    else if (isPunct(src.tokens[i], ":")) return i;
  }
  return undefined;
}

/** The end of the type that starts at `from`: the first `=`, `,`, `;` or closer outside it. */
function typeEnd(src: Source, from: number): number {
  const { tokens, pairs } = src;
  let angles = 0;
  for (let i = from; i < tokens.length; i++) {
    const close = pairs.get(i);
    const t = tokens[i];
    if (close !== undefined) i = close;
    else if (isPunct(t, "<")) angles++;
    else if (t?.kind === "punct" && /^>+$/.test(t.value)) angles -= t.value.length;
    else if (isCloser(t) || isPunct(t, ";") || isPunct(t, "=")) return i;
    else if (isPunct(t, ",") && angles <= 0) return i;
  }
  return tokens.length;
}

/** The names a binding target at `k` binds: a name, or every name a `{…}` or `[…]` pattern holds. */
function targetNames(src: Source, k: number, out: Set<string> = new Set()): Set<string> {
  const t = src.tokens;
  const token = t[k];
  if (isName(token)) {
    out.add(token.value);
    return out;
  }
  const close = src.pairs.get(k);
  const array = isPunct(token, "[");
  if (close === undefined || !(array || isPunct(token, "{"))) return out;
  for (const [ps, pe] of commaParts(src, k + 1, close)) {
    if (ps >= pe) continue;
    if (isPunct(t[ps], "...")) targetNames(src, ps + 1, out);
    else if (array) targetNames(src, ps, out);
    else targetNames(src, (colonIn(src, ps, pe) ?? ps - 1) + 1, out);
  }
  return out;
}

/** The first token before the `(` at `open`, past type parameters or arguments (`f<T>(`). */
function beforeTypeParameters(src: Source, open: number): number {
  const t = src.tokens;
  const last = open - 1;
  if (!isPunct(t[last], ">")) return last;
  let angles = 0;
  for (let i = last; i >= 0; i--) {
    const opener = src.openers.get(i);
    const token = t[i];
    if (opener !== undefined) i = opener;
    else if (token?.kind === "punct" && /^>+$/.test(token.value)) angles += token.value.length;
    else if (isPunct(token, "<") && --angles === 0) return i - 1;
    else if (isPunct(token, ";") || (token?.kind === "punct" && OPENERS.has(token.value))) break;
  }
  return last;
}

/** A function's body after its parameters (and return type), from `from`: a `{` block or `=>`. */
function bodyAfter(
  src: Source,
  from: number,
): { arrow: boolean; body: [number, number] } | undefined {
  const t = src.tokens;
  let k = from;
  if (isPunct(t[k], ":")) {
    for (k++; k < t.length && !isPunct(t[k], "=>"); k++) {
      const close = src.pairs.get(k);
      const before = t[k - 1];
      if (
        isPunct(t[k], "{") &&
        !(before?.kind === "punct" && TYPE_LITERAL_AFTER.has(before.value))
      ) {
        break;
      }
      if (close !== undefined) k = close;
      else if (isCloser(t[k]) || isPunct(t[k], ";") || isPunct(t[k], ",") || isPunct(t[k], "=")) {
        return undefined;
      }
    }
  }
  if (isPunct(t[k], "=>")) {
    const start = k + 1;
    const end = isPunct(t[start], "{") ? (src.pairs.get(start) ?? start) + 1 : exprEnd(src, start);
    return { arrow: true, body: [start, end] };
  }
  const close = isPunct(t[k], "{") ? src.pairs.get(k) : undefined;
  return close === undefined ? undefined : { arrow: false, body: [k, close + 1] };
}

/** The name a function is given by what stands before it: `const line = (`, `write: (`, `x = async`. */
function assignedName(src: Source, last: number): string {
  const t = src.tokens;
  let k = last;
  if (isName(t[k], "async")) k--;
  if (isPunct(t[k], "*")) k--;
  if (isName(t[k], "function")) k--;
  if (isName(t[k], "async")) k--;
  if (!isPunct(t[k], "=") && !isPunct(t[k], ":")) return "";
  let j = k - 1;
  if (isPunct(t[k], "=")) {
    // `name: Type = (`: the name stands before the type's `:`.
    for (let i = j; i >= 0; i--) {
      const opener = src.openers.get(i);
      const token = t[i];
      if (opener !== undefined) i = opener;
      else if (isPunct(token, ":")) {
        j = i - 1;
        break;
      } else if (
        isPunct(token, ";") ||
        isPunct(token, "=") ||
        isPunct(token, ",") ||
        (token?.kind === "punct" && OPENERS.has(token.value)) ||
        isDeclaration(token)
      ) {
        break;
      }
    }
  }
  if (isPunct(t[j], "?") || isPunct(t[j], "!")) j--;
  const name = t[j];
  if (isName(name)) return name.value;
  return name?.kind === "private-name" ? name.value.slice(1) : "";
}

/**
 * The function whose parameters the `(` at `open` opens (see the rule above): its name and body,
 * or undefined for a call's arguments, a head's condition or a parenthesized expression.
 */
function functionAt(src: Source, open: number): CodeFunction | undefined {
  const t = src.tokens;
  const close = src.pairs.get(open) ?? open;
  const k = beforeTypeParameters(src, open);
  const before = t[k];
  const found = bodyAfter(src, close + 1);
  if (found === undefined) return undefined;
  const params: [number, number] = [open, close + 1];
  const keyed =
    before?.kind === "private-name" ||
    before?.kind === "string" ||
    before?.kind === "number" ||
    isPunct(before, "]") ||
    (isName(before) && !EXPRESSION_WORDS.has(before.value));
  if (keyed) {
    // A name before `(`: a call's callee, unless it names a function or starts a member.
    if (found.arrow || (isName(before) && CONTROL_WORDS.has(before.value))) return undefined;
    const key = isPunct(before, "]") ? (src.openers.get(k) ?? k) : k;
    const prev = t[key - 1];
    const starts =
      prev === undefined ||
      isName(prev, "function") ||
      isPunct(prev, "*") ||
      isPunct(prev, "{") ||
      isPunct(prev, "}") ||
      isPunct(prev, ",") ||
      isPunct(prev, ";") ||
      (isName(prev) && MEMBER_MODIFIERS.has(prev.value));
    if (!starts) return undefined;
    const name =
      before?.kind === "private-name" ? before.value.slice(1) : isName(before) ? before.value : "";
    return { name, params, body: found.body };
  }
  // `function (` and `function* (`: an anonymous function's, with a block body.
  const fn = isName(before, "function") || (isPunct(before, "*") && isName(t[k - 1], "function"));
  if (fn === found.arrow) return undefined;
  return { name: assignedName(src, k), params, body: found.body };
}

/** Every function, method and arrow in the file (see the rule above). */
function functionsOf(src: Source): readonly CodeFunction[] {
  if (src.functions !== undefined) return src.functions;
  const t = src.tokens;
  const found: CodeFunction[] = [];
  for (const open of src.pairs.keys()) {
    if (!isPunct(t[open], "(")) continue;
    const fn = functionAt(src, open);
    if (fn !== undefined) found.push(fn);
  }
  // An arrow's one parameter: `x => …`, `async x => …`.
  for (let i = 0; i < t.length; i++) {
    if (!isName(t[i]) || !isPunct(t[i + 1], "=>") || isMember(src, i)) continue;
    const body = bodyAfter(src, i + 1);
    if (body === undefined) continue;
    found.push({ name: assignedName(src, i - 1), params: [i, i + 1], body: body.body });
  }
  src.functions = found;
  return found;
}

/** A function's parameters, each as [start, end). */
function parametersOf(src: Source, fn: CodeFunction): [number, number][] {
  const [open, end] = fn.params;
  return isPunct(src.tokens[open], "(") ? commaParts(src, open + 1, end - 1) : [[open, end]];
}

/** The names a parameter binds: its target's, after a rest parameter's `...`. */
function parameterNames(src: Source, [start, end]: [number, number]): Set<string> {
  if (start >= end) return new Set();
  return targetNames(src, isPunct(src.tokens[start], "...") ? start + 1 : start);
}

/** What a name is bound to where a call stands (see the rule above). */
interface Binding {
  /** A `const`, `let` or `var` with a value, a `for … of` list, an adapter's parameter, or other. */
  readonly kind: "value" | "list" | "adapter" | "other";
  readonly scope: readonly [number, number];
  /** Where the name is bound: its token, or an adapter's parameters' first token. */
  readonly at: number;
  /** The value's tokens, or the list's, as [start, end). */
  readonly value?: readonly [number, number];
  /** A `let` or `var`. */
  readonly mutable?: boolean;
  /** An adapter's body, where its parameter is never assigned again. */
  readonly body?: readonly [number, number];
}

/** A declaration's scope: its block, or a loop's head and body for the loop's own. */
function scopeOf(src: Source, [open, end]: [number, number]): [number, number] {
  const t = src.tokens;
  if (!isPunct(t[open], "(") || !forHead(src, open)) return [open, end];
  const body = isPunct(t[end], "{") ? (src.pairs.get(end) ?? end) + 1 : exprEnd(src, end);
  return [open, body];
}

/** Whether the `(` at `open` opens a `for` head (`for (`, `for await (`). */
function forHead(src: Source, open: number): boolean {
  const t = src.tokens;
  return isName(t[open - 1], "for") || (isName(t[open - 1], "await") && isName(t[open - 2], "for"));
}

/** Every binding of `name` in the file: declarations, imports and parameters. */
function bindingsOf(src: Source, name: string): readonly Binding[] {
  const known = src.bindings.get(name);
  if (known !== undefined) return known;
  const t = src.tokens;
  const out: Binding[] = [];
  src.bindings.set(name, out);
  for (let i = 0; i < t.length; i++) {
    // `let` with no binding after it is an identifier; `as const` declares nothing.
    const first = t[i + 1];
    const binds = isName(first) || isPunct(first, "{") || isPunct(first, "[");
    if (!isDeclaration(t[i]) || !binds || isMember(src, i) || isName(t[i - 1], "as")) continue;
    const around = enclosing(src, i);
    const scope = scopeOf(src, around);
    const inParens = (src.parents[i] ?? -1) >= 0 && isPunct(t[around[0]], "(");
    const mutable = !isName(t[i], "const");
    // Each declarator: a name or a pattern, a definite `!`, a type, and a value.
    for (let k = i + 1; k < t.length; ) {
      const pattern = !isName(t[k]);
      if (pattern && !isPunct(t[k], "{") && !isPunct(t[k], "[")) break;
      const bound = targetNames(src, k).has(name);
      let next = pattern ? (src.pairs.get(k) ?? k) + 1 : k + 1;
      if (isPunct(t[next], "!")) next++;
      if (isPunct(t[next], ":")) next = typeEnd(src, next + 1);
      let end = next;
      if (isPunct(t[next], "=")) {
        end = exprEnd(src, next + 1);
        if (bound && !pattern) {
          out.push({ kind: "value", scope, at: k, value: [next + 1, end], mutable });
        } else if (bound) out.push({ kind: "other", scope, at: k });
      } else if (bound && !pattern && isName(t[next], "of") && inParens) {
        out.push({ kind: "list", scope, at: k, value: [next + 1, around[1] - 1], mutable });
      } else if (bound) out.push({ kind: "other", scope, at: k });
      if (!isPunct(t[end], ",")) break;
      k = end + 1;
    }
  }
  for (let i = 0; i < t.length; i++) {
    if (isName(t[i], "import") && !isMember(src, i)) out.push(...importBindings(src, i, name));
  }
  for (const fn of functionsOf(src)) {
    const params = parametersOf(src, fn);
    if (!params.some((p) => parameterNames(src, p).has(name))) continue;
    const first = params[0];
    const adapter =
      WRITER_METHODS.has(fn.name) &&
      first !== undefined &&
      parameterNames(src, first).has(name) &&
      !src.tokens.slice(first[0], first[1]).some((tok) => isPunct(tok, "="));
    const scope: [number, number] = [fn.params[0], fn.body[1]];
    out.push(
      adapter
        ? { kind: "adapter", scope, at: fn.params[0], body: fn.body }
        : { kind: "other", scope, at: fn.params[0] },
    );
  }
  return out;
}

/**
 * The bindings of `name` the import statement at `at` makes: its clause, to `from` and the module's
 * string, binds a default import, a namespace's name and each named import (a name renamed `as`
 * binds its new name). `import(…)`, `import.meta` and a bare `import "x"` bind nothing.
 */
function importBindings(src: Source, at: number, name: string): Binding[] {
  const t = src.tokens;
  const found: number[] = [];
  const binds = (k: number) => isName(t[k], name) && !isName(t[k + 1], "as");
  let k = at + 1;
  if (isName(t[k], "type") && !isName(t[k + 1], "from") && !isPunct(t[k + 1], ",")) k++;
  for (; k < t.length && !isName(t[k], "from"); k++) {
    const close = isPunct(t[k], "{") ? src.pairs.get(k) : undefined;
    if (close !== undefined) {
      for (let j = k + 1; j < close; j++) if (binds(j)) found.push(j);
      k = close;
    } else if (isName(t[k])) {
      if (binds(k)) found.push(k);
    } else if (!isPunct(t[k], "*") && !isPunct(t[k], ",")) return [];
  }
  if (t[k + 1]?.kind !== "string") return [];
  return found.map((j) => ({ kind: "other", scope: [0, t.length], at: j }));
}

/** The binding of `name` whose scope holds `at` most closely, or undefined when none does. */
function bindingOf(src: Source, name: string, at: number): Binding | undefined {
  let best: Binding | undefined;
  for (const b of bindingsOf(src, name)) {
    if (b.scope[0] > at || at >= b.scope[1]) continue;
    const span = b.scope[1] - b.scope[0];
    const bestSpan = best === undefined ? Infinity : best.scope[1] - best.scope[0];
    if (
      span < bestSpan ||
      (span === bestSpan && best !== undefined && b.at <= at && b.at > best.at)
    ) {
      best = b;
    }
  }
  return best;
}

/** Whether the token is an assignment operator: `=` or a compound one. */
function isAssignment(token: Token | undefined): boolean {
  return token?.kind === "punct" && token.jsx !== true && ASSIGNMENTS.has(token.value);
}

/**
 * Whether the name at `i` is a target of a destructuring assignment (`({ name } = o)`, `[name] =
 * o`) or of a `for … of` or `for … in` head (`for (name of o)`, `for ([name] of o)`).
 */
function assignedTarget(src: Source, i: number): boolean {
  const t = src.tokens;
  const loop = (open: number, after: Token | undefined) =>
    isPunct(t[open], "(") && forHead(src, open) && (isName(after, "of") || isName(after, "in"));
  if (loop(i - 1, t[i + 1])) return true;
  if (isPunct(t[i + 1], ":")) return false;
  // The `{…}` or `[…]` around it, read as a pattern, and each pattern around that one: a nested
  // pattern stands after an outer one's `[`, `,`, `:` or `...`.
  const pattern = (open: number) => isPunct(t[open], "{") || isPunct(t[open], "[");
  let outer = src.parents[i] ?? -1;
  if (outer < 0 || !pattern(outer)) return false;
  for (let up = src.parents[outer] ?? -1; up >= 0 && pattern(up); up = src.parents[up] ?? -1) {
    const before = t[outer - 1];
    const nested = [",", ":", "...", "["].some((p) => isPunct(before, p));
    if (!nested) break;
    outer = up;
  }
  if (isDeclaration(t[outer - 1])) return false;
  const after = t[(src.pairs.get(outer) ?? outer) + 1];
  return isPunct(after, "=") || loop(outer - 1, after);
}

/** Whether code in `scope` assigns `name` again, other than where the token `at` declares it. */
function assignedAgain(
  src: Source,
  name: string,
  scope: readonly [number, number],
  at: number,
): boolean {
  const t = src.tokens;
  for (let i = scope[0]; i < scope[1]; i++) {
    if (i === at || !isName(t[i], name) || isMember(src, i)) continue;
    const steps = (token: Token | undefined) => isPunct(token, "++") || isPunct(token, "--");
    if (isAssignment(t[i + 1]) || steps(t[i + 1]) || steps(t[i - 1]) || assignedTarget(src, i)) {
      return true;
    }
  }
  return false;
}

/** Whether code in `scope` changes the object `name` holds: its `event`, a computed key, or all. */
function objectChanged(src: Source, name: string, scope: readonly [number, number]): boolean {
  const t = src.tokens;
  for (let i = scope[0]; i < scope[1]; i++) {
    if (!isName(t[i], name) || isMember(src, i)) continue;
    const k = isPunct(t[i + 1], "!") ? i + 2 : i + 1;
    const dot = isPunct(t[k], ".") || isPunct(t[k], "?.");
    const key = isPunct(t[k], "[") ? src.pairs.get(k) : undefined;
    if (
      (dot && isName(t[k + 1], "event") && isAssignment(t[k + 2])) ||
      (key !== undefined && isAssignment(t[key + 1])) ||
      (isName(t[i - 1], "delete") && (dot || key !== undefined)) ||
      (isPunct(t[i - 1], "(") &&
        isName(t[i - 2], "assign") &&
        isPunct(t[i - 3], ".") &&
        isName(t[i - 4], "Object"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether code changes what the binding of `name` holds, found once per binding: an adapter's
 * parameter assigned again in its body; a `let` or `var` assigned again in its scope; an object
 * whose `event` is assigned, or changed whole, there.
 */
function changedAgain(src: Source, name: string, binding: Binding): boolean {
  const known = src.changed.get(binding);
  if (known !== undefined) return known;
  const changed =
    binding.kind === "adapter"
      ? binding.body !== undefined && assignedAgain(src, name, binding.body, -1)
      : (binding.mutable === true && assignedAgain(src, name, binding.scope, binding.at)) ||
        objectChanged(src, name, binding.scope);
  src.changed.set(binding, changed);
  return changed;
}

/** A forwarding adapter's first parameter, by where it is bound (-1 for a parameter list). */
interface AdapterParameter {
  readonly adapter: number;
}

/**
 * What a telemetry writer's argument gives: names; a message (no name, through `this` or a bare
 * call only); an adapter's parameter; a string out of the event-name shape; or nothing readable.
 */
type Reading = string[] | "message" | "misnamed" | "unread" | AdapterParameter;

function isAdapter(read: Reading): read is AdapterParameter {
  return typeof read === "object" && !Array.isArray(read);
}

/** Names from strings: each in the event-name shape, or messages only, or out of the shape. */
function classify(values: readonly string[]): Reading {
  if (values.every((v) => EVENT_NAME.test(v))) return [...values];
  if (values.every((v) => v === "" || MESSAGE_TEXT.test(v))) return "message";
  return "misnamed";
}

/** The `?` and `:` of a ternary standing outside any bracket in [start, end), or undefined. */
function ternaryIn(src: Source, start: number, end: number): [number, number] | undefined {
  let question = -1;
  let nested = 0;
  for (let i = start; i < end; i++) {
    const close = src.pairs.get(i);
    const t = src.tokens[i];
    if (close !== undefined) i = close;
    else if (isPunct(t, "?")) {
      if (question < 0) question = i;
      else nested++;
    } else if (isPunct(t, ":") && question >= 0) {
      if (nested === 0) return [question, i];
      nested--;
    }
  }
  return undefined;
}

/** The first `||`, `??` or `&&` standing outside any bracket in [start, end), or undefined. */
function logicalIn(src: Source, start: number, end: number): number | undefined {
  for (let i = start; i < end; i++) {
    const close = src.pairs.get(i);
    const t = src.tokens[i];
    if (close !== undefined) i = close;
    else if (isPunct(t, "||") || isPunct(t, "??") || isPunct(t, "&&")) return i;
  }
  return undefined;
}

/**
 * The strings an expression is made of when every leaf is one, or undefined: a string, or strings
 * joined by a ternary (its branches), `||`, `??` or `&&`.
 */
function stringLeaves(src: Source, start: number, end: number): string[] | undefined {
  const t = src.tokens;
  if (start >= end) return undefined;
  if (isPunct(t[start], "(") && src.pairs.get(start) === end - 1) {
    return stringLeaves(src, start + 1, end - 1);
  }
  const ternary = ternaryIn(src, start, end);
  if (ternary !== undefined) {
    const yes = stringLeaves(src, ternary[0] + 1, ternary[1]);
    const no = stringLeaves(src, ternary[1] + 1, end);
    return yes === undefined || no === undefined ? undefined : [...yes, ...no];
  }
  const logical = logicalIn(src, start, end);
  if (logical !== undefined) {
    const left = stringLeaves(src, start, logical);
    const right = stringLeaves(src, logical + 1, end);
    return left === undefined || right === undefined ? undefined : [...left, ...right];
  }
  const token = t[start];
  return end === start + 1 && isLiteral(token) ? [token.value] : undefined;
}

/** A literal operand's static text: a string's, or each piece of a template (none of its `${…}`). */
function staticParts(src: Source, start: number, end: number): string[] | undefined {
  const t = src.tokens;
  const token = t[start];
  if (end === start + 1 && isLiteral(token)) return [token.value];
  if (token?.kind !== "template-head" || src.pairs.get(start) !== end - 1) return undefined;
  const parts = [token.value];
  for (let i = start + 1; i < end; i++) {
    const piece = t[i];
    const close = src.pairs.get(i);
    if (close !== undefined) i = close;
    else if (piece?.kind === "template-middle" || piece?.kind === "template-tail") {
      parts.push(piece.value);
    }
  }
  return parts;
}

/** A message, or a name built at run time (see the rule above). */
function builtOrMessage(src: Source, start: number, end: number): Reading {
  if (ternaryIn(src, start, end) !== undefined) return "unread";
  let from = start;
  let spaced = false;
  for (let i = start; i <= end; i++) {
    if (i < end) {
      const close = src.pairs.get(i);
      const t = src.tokens[i];
      if (close !== undefined) {
        i = close;
        continue;
      }
      if (isPunct(t, "?") || isPunct(t, "??") || isPunct(t, "||") || isPunct(t, "&&")) {
        return "unread";
      }
      if (!isPunct(t, "+")) continue;
    }
    if (staticParts(src, from, i)?.some((part) => MESSAGE_TEXT.test(part))) spaced = true;
    from = i + 1;
  }
  return spaced ? "message" : "unread";
}

/** A name and its members (`line`, `line.event`, `x!.y`, `a?.#b`), or undefined. */
function pathAt(
  src: Source,
  start: number,
  end: number,
): { root: string; members: string[] } | undefined {
  const t = src.tokens;
  const root = t[start];
  if (!isName(root)) return undefined;
  const members: string[] = [];
  for (let i = start + 1; i < end; i += 2) {
    if (isPunct(t[i], "!")) i++;
    const member = t[i + 1];
    if (!(isPunct(t[i], ".") || isPunct(t[i], "?.")) || i + 1 >= end) return undefined;
    if (isName(member) || member?.kind === "private-name") members.push(member.value);
    else return undefined;
  }
  return { root: root.value, members };
}

/** What an expression gives as a line's name, read as the rule above says. */
function readValue(src: Source, start: number, end: number, depth: number): Reading {
  const t = src.tokens;
  const asConst = end - start >= 3 && isName(t[end - 2], "as") && isName(t[end - 1], "const");
  const e = asConst ? end - 2 : end;
  if (start >= e || depth > 8) return "unread";
  if (isPunct(t[start], "(") && src.pairs.get(start) === e - 1) {
    return readValue(src, start + 1, e - 1, depth + 1);
  }
  if (isPunct(t[start], "{") && src.pairs.get(start) === e - 1) {
    return readObject(src, start, e, depth);
  }
  const leaves = stringLeaves(src, start, e);
  if (leaves !== undefined) return classify(leaves);
  const path = pathAt(src, start, e);
  if (path !== undefined) return readPath(src, path.root, path.members, start, depth);
  return builtOrMessage(src, start, e);
}

/** An object literal's own `event`: its value read as a name, or unread. */
function readObject(src: Source, start: number, end: number, depth: number): Reading {
  const t = src.tokens;
  let event: { at: number; value: [number, number] | undefined } | undefined;
  let spreadAfter = false;
  for (const [ps, pe] of commaParts(src, start + 1, end - 1)) {
    if (ps >= pe) continue;
    if (isPunct(t[ps], "...")) {
      if (event !== undefined) spreadAfter = true;
      continue;
    }
    if (isEventKey(t[ps]) && isPunct(t[ps + 1], ":")) event = { at: ps, value: [ps + 2, pe] };
    else if (pe === ps + 1 && isName(t[ps], "event")) event = { at: ps, value: undefined };
    else continue;
    spreadAfter = false;
  }
  if (event === undefined || spreadAfter) return "unread";
  const read =
    event.value === undefined
      ? readPath(src, "event", [], event.at, depth + 1)
      : readValue(src, event.value[0], event.value[1], depth + 1);
  // An object names a line by its `event`: a message there is no name, whoever writes it.
  return read === "message" ? "misnamed" : read;
}

/** A variable, or its `.event`, read from the binding where it stands. */
function readPath(
  src: Source,
  root: string,
  members: readonly string[],
  at: number,
  depth: number,
): Reading {
  const read = readBinding(src, root, members, at, depth);
  // A variable's value that is no event name is a finding, a message included.
  return read === "message" ? "misnamed" : read;
}

function readBinding(
  src: Source,
  root: string,
  members: readonly string[],
  at: number,
  depth: number,
): Reading {
  const t = src.tokens;
  if (root === "this" || depth > 8) return "unread";
  const binding = bindingOf(src, root, at);
  if (binding?.kind === "adapter") {
    // An adapter forwards its parameter whole, or a line's `.event`, as its caller passed it:
    // another member, or a parameter it assigns again, is no name.
    const forwarded = members.length === 0 || (members.length === 1 && members[0] === "event");
    return forwarded && !changedAgain(src, root, binding) ? { adapter: binding.at } : "unread";
  }
  if (binding?.value === undefined || changedAgain(src, root, binding)) return "unread";
  const [s, e] = binding.value;
  if (binding.kind === "list") {
    const asConst = e - s >= 3 && isName(t[e - 2], "as") && isName(t[e - 1], "const");
    const end = asConst ? e - 2 : e;
    if (members.length > 0 || !isPunct(t[s], "[") || src.pairs.get(s) !== end - 1) return "unread";
    const values: string[] = [];
    for (const [ps, pe] of commaParts(src, s + 1, end - 1)) {
      if (ps >= pe) continue;
      const leaves = stringLeaves(src, ps, pe);
      if (leaves === undefined) return "unread";
      values.push(...leaves);
    }
    return classify(values);
  }
  if (members.length === 0) return readValue(src, s, e, depth + 1);
  const close = isPunct(t[s], "{") ? src.pairs.get(s) : undefined;
  if (members.length > 1 || members[0] !== "event" || close === undefined) return "unread";
  return readObject(src, s, close + 1, depth + 1);
}

/** A telemetry writer's call: the names its first argument gives (see the rule above). */
function readCall(src: Source, open: number): Reading {
  const t = src.tokens;
  const s = open + 1;
  const e = exprEnd(src, s);
  if (s >= e) return "message";
  // A parameter list, not a call: a typed parameter (`log(event: string, …)`, a signature's), a
  // typed pattern (`write({ event }: Line)`), or a function's own (`write(event, level) {`).
  const pattern = isPunct(t[s], "{") ? src.pairs.get(s) : undefined;
  const typed = isPunct(t[s + 1], ":") || (isPunct(t[s + 1], "?") && isPunct(t[s + 2], ":"));
  if ((isName(t[s]) && typed) || (pattern !== undefined && isPunct(t[pattern + 1], ":"))) {
    return { adapter: -1 };
  }
  if (
    isName(t[s], "JSON") &&
    isPunct(t[s + 1], ".") &&
    isName(t[s + 2], "stringify") &&
    isPunct(t[s + 3], "(")
  ) {
    return "message";
  }
  const leaves = stringLeaves(src, s, e);
  if (leaves !== undefined) return classify(leaves);
  if (functionsOf(src).some((fn) => fn.params[0] === open)) return { adapter: -1 };
  return readValue(src, s, e, 0);
}

/** What the method at `at` is called on: a name, "" for any other receiver, or undefined. */
function receiverOf(src: Source, at: number): string | undefined {
  const t = src.tokens;
  if (!isMember(src, at)) return undefined;
  const k = isPunct(t[at - 2], "!") ? at - 3 : at - 2;
  const receiver = t[k];
  if (isName(receiver)) return receiver.value;
  return receiver?.kind === "private-name" ? receiver.value.slice(1) : "";
}

/** Every writer method's call in the file: a writer method's name, then `(` or `?.(`. */
function writerCalls(src: Source): readonly WriterCall[] {
  if (src.calls !== undefined) return src.calls;
  const t = src.tokens;
  const calls: WriterCall[] = [];
  for (let i = 0; i < t.length; i++) {
    const token = t[i];
    const named = isName(token) || token?.kind === "private-name";
    const method = token?.kind === "private-name" ? token.value.slice(1) : (token?.value ?? "");
    if (!named || !WRITER_METHODS.has(method)) continue;
    const open = isPunct(t[i + 1], "?.") ? i + 2 : i + 1;
    if (!isPunct(t[open], "(")) continue;
    calls.push({ at: i, open, method, spelled: token.value, receiver: receiverOf(src, i) });
  }
  src.calls = calls;
  return calls;
}

/**
 * The writer methods the file declares as adapters (see the rule above): a function, method or
 * property named as a writer method whose first parameter a telemetry writer's call in its body is
 * passed, or an adapter's call, found until no more are.
 */
function adaptersOf(src: Source): ReadonlySet<string> {
  if (src.adapters !== undefined) return src.adapters;
  const found = new Set<string>();
  src.adapters = found;
  const named = functionsOf(src).filter((fn) => WRITER_METHODS.has(fn.name));
  if (named.length === 0) return found;
  for (let grew = true; grew; ) {
    grew = false;
    for (const call of writerCalls(src)) {
      if (!TELEMETRY_WRITERS.has(call.receiver ?? call.method) && !found.has(call.method)) continue;
      const read = readCall(src, call.open);
      if (!isAdapter(read)) continue;
      for (const fn of named) {
        if (fn.params[0] === read.adapter && !found.has(fn.name)) {
          found.add(fn.name);
          grew = true;
        }
      }
    }
  }
  return found;
}

/** A writer call MC-01 refuses, or a file it cannot tokenize: where, and the finding's message. */
interface Refusal {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/**
 * What eventsInCode reads: the events, and the writer calls whose name it cannot read or that is
 * out of the event-name shape, and the files it cannot tokenize, in the order the files hold them.
 */
function scanWriters(code: readonly CodeFile[]): {
  found: Map<string, CodeEvent>;
  refused: Refusal[];
} {
  const found = new Map<string, CodeEvent>();
  const refused: Refusal[] = [];
  const add = (event: string, at: CodeEvent) => {
    if (!found.has(event)) found.set(event, at);
  };
  for (const { file, text } of code) {
    let src: Source;
    try {
      src = sourceOf(file, text);
    } catch (error) {
      if (!(error instanceof TokenizeError)) throw error;
      refused.push({
        file,
        line: error.line,
        message: `the tokenizer cannot read the file from column ${error.column} of this line (${error.reason}), so MC-01 reads none of its writer calls: a misread could hide one`,
      });
      continue;
    }
    const t = src.tokens;
    for (const writer of writerCalls(src)) {
      const { receiver } = writer;
      const callee = receiver === undefined ? writer.spelled : `${receiver}.${writer.spelled}`;
      const line = t[writer.at]?.line ?? 0;
      const s = writer.open + 1;
      const e = exprEnd(src, s);
      const whole = s < e ? text.slice(t[s]?.start, t[e - 1]?.end).replace(/\s+/g, " ") : "";
      const shown = whole.length > 60 ? `${whole.slice(0, 57)}…` : whole;
      if (
        !TELEMETRY_WRITERS.has(receiver ?? writer.method) &&
        !adaptersOf(src).has(writer.method)
      ) {
        // Each name the first argument's strings give, whole (`"x.y"`, `a ? "x.y" : "x.z"`), or
        // an object's literal `event`.
        const leaves = stringLeaves(src, s, e);
        for (const name of leaves ?? []) {
          if (!EVENT_NAME.test(name) || !name.includes(".")) continue;
          const call =
            leaves?.length === 1 ? `${callee}("${name}")` : `${callee}(${shown}: "${name}")`;
          add(name, { file, line, call });
        }
        const object = leaves === undefined ? literalEvent(src, s) : undefined;
        if (object?.includes(".") === true) {
          add(object, { file, line, call: `${callee}({ event: "${object}" })` });
        }
        continue;
      }
      let read = readCall(src, writer.open);
      if (isAdapter(read)) continue;
      if (read === "message") {
        // A message only through `this` or a bare call: through a member call it is a line.
        if (receiver === undefined || receiver === "this") continue;
        read = "misnamed";
      }
      if (read === "unread") {
        refused.push({
          file,
          line,
          message: `${callee}(${shown}) writes a name MC-01 cannot read: write the event's name as a literal`,
        });
        continue;
      }
      if (read === "misnamed") {
        refused.push({
          file,
          line,
          message: `${callee}(${shown}) writes a name out of the event-name shape: write <area>.<name> in lower case (any other ships as telemetry.bad_event)`,
        });
        continue;
      }
      const literal = stringLeaves(src, s, e)?.length === 1;
      const object = isPunct(t[s], "{");
      for (const name of read) {
        const call = literal
          ? `${callee}("${name}")`
          : object
            ? `${callee}({ event: "${name}" })`
            : `${callee}(${shown}: "${name}")`;
        add(name, { file, line, call });
      }
    }
    for (const event of rawLines(src)) {
      add(event.name, {
        file,
        line: event.line,
        call: `JSON.stringify({ event: "${event.name}" })`,
      });
    }
  }
  return { found, refused };
}

/** Another writer's object argument at `at`: its own `event` key's literal name, or undefined. */
function literalEvent(src: Source, at: number): string | undefined {
  const t = src.tokens;
  const close = isPunct(t[at], "{") ? src.pairs.get(at) : undefined;
  if (close === undefined) return undefined;
  for (const [ps] of commaParts(src, at + 1, close)) {
    const value = t[ps + 2];
    if (isEventKey(t[ps]) && isPunct(t[ps + 1], ":") && isLiteral(value)) {
      if (EVENT_NAME.test(value.value)) return value.value;
    }
  }
  return undefined;
}

/** The raw lines' events: each `event: "x.y"` property inside a `JSON.stringify(…)` call. */
function rawLines(src: Source): { name: string; line: number }[] {
  const t = src.tokens;
  const out: { name: string; line: number }[] = [];
  for (let i = 0; i < t.length; i++) {
    const stringify =
      isName(t[i], "JSON") &&
      !isMember(src, i) &&
      isPunct(t[i + 1], ".") &&
      isName(t[i + 2], "stringify") &&
      isPunct(t[i + 3], "(");
    if (!stringify) continue;
    const close = src.pairs.get(i + 3) ?? i;
    for (let k = i + 4; k < close; k++) {
      const value = t[k + 2];
      const key = isPunct(t[k - 1], "{") || isPunct(t[k - 1], ",");
      if (!key || !isEventKey(t[k]) || !isPunct(t[k + 1], ":") || !isLiteral(value)) continue;
      if (EVENT_NAME.test(value.value)) out.push({ name: value.value, line: t[k]?.line ?? 0 });
    }
  }
  return out;
}

/** Events written in code, each with the first place that writes it (see the rule above). */
export function eventsInCode(
  root: string,
  code: readonly CodeFile[] = readCode(root),
): Map<string, CodeEvent> {
  return scanWriters(code).found;
}

/** A source file the code scans read, and its text. */
export interface CodeFile {
  readonly file: string;
  readonly text: string;
}

/** The files both code scans read, once: TypeScript outside tests and ops/monitoring. */
export function readCode(root: string): CodeFile[] {
  const files: string[] = [];
  for (const dir of CODE_DIRS) walk(root, dir, files);
  return files
    .sort()
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.(?:db\.)?test\.tsx?$/.test(file) &&
        !file.startsWith("ops/monitoring/"),
    )
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

// MC-15's scan: the alert names the code gives, in the same files as MC-01's (ops/monitoring's own
// catalogue is read as data). The code names an alert in two ways, and the scan reads each:
//   1. a line list: an `alerts` property whose value is a string or an array, each string at the
//      array's top level a name (packages/identity/src/monitoring.ts's IDENTITY_LINES; a value of
//      another kind, such as `{ none: "…" }` or a type, names none);
//   2. text that calls a backquoted name an alert, in a comment or a string: "alert (`x`)",
//      "alert `x`" or "the `x` alert"; and the duty alerts' family name `duty-stalled-<duty>`
//      (ARCHITECTURE §10.8 group I) wherever it stands.
// Prose that names an alert in other words ("`x` watches it") is beyond a lexical scan, as a writer
// reached another way is for MC-01: a review finding.
const ALERT_NAME = /^[a-z0-9]+(?:-(?:[a-z0-9]+|\{[a-z]+\}))+$/;
const ALERTS_PROPERTY = /(?<![\w$.])(?:alerts|"alerts"|'alerts')\s*:\s*/g;
const ALERT_PROSE =
  /\balerts?\s*\(?\s*`([a-z0-9]+(?:-[a-z0-9]+)+)`|`([a-z0-9]+(?:-[a-z0-9]+)+)`\s+alert\b|(?<![\w-])(duty-stalled-[a-z0-9]+(?:-[a-z0-9]+)*)/g;
/** Text that names an alert the way the specs' tables do: `<name> (P, …)`. */
const SEVERITY_NAMED = /(?<![\w-])([a-z0-9]+(?:-[a-z0-9]+)+) \((?:P|N)\b/g;
/**
 * Any alert-shaped word in a noAlert reason: words of lower-case letters and digits joined by
 * hyphens, not part of a path, a file name, an event or an overlay key (`docs/runbooks/x-y.md`,
 * `@thresholds.x-y`). A reason that names an alert claims its cover, in whatever words, so a
 * reason writes other hyphenated words apart ("sign in", "step up").
 */
const ALERT_WORD = /(?<![\w./@#-])[a-z0-9]+(?:-(?:[a-z0-9]+|\{[a-z]+\}))+(?![\w/{-]|\.\w)/g;

/** Where the code names an alert. */
export interface CodeAlert {
  readonly file: string;
  readonly line: number;
}

// MC-15 reads the text itself, comments and strings included (prose names an alert there).
/** The index of the quote that ends the string starting at `start`, or -1. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === quote) return i;
    else if (quote === "`" && c === "$" && text[i + 1] === "{") {
      const end = closing(text, i + 1);
      if (end < 0) return -1;
      i = end - 1;
    } else if (quote !== "`" && c === "\n") return -1;
  }
  return -1;
}

/** The index of the string's or comment's last character at `i`; undefined when none starts there. */
function skipped(text: string, i: number): number | undefined {
  const c = text[i];
  if (c === '"' || c === "'" || c === "`") return stringEnd(text, i);
  if (c === "/" && text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length - 1 : end;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? -1 : end + 1;
  }
  return undefined;
}

/** The index just past the bracket that closes the one at `open`, or -1 when it is not closed. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const skip = skipped(text, i);
    if (skip !== undefined) {
      if (skip < 0) return -1;
      i = skip;
      continue;
    }
    const c = text[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** The strings at the top level of the array at `open` (none for a template with `${`). */
function topLevelStrings(text: string, open: number): { value: string; at: number }[] {
  const end = closing(text, open);
  if (end < 0) return [];
  const out: { value: string; at: number }[] = [];
  for (let i = open + 1; i < end - 1; i++) {
    const c = text[i] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      const close = stringEnd(text, i);
      if (close < 0) return out;
      const value = text.slice(i + 1, close);
      if (!value.includes("${")) out.push({ value, at: i });
      i = close;
      continue;
    }
    const skip = skipped(text, i);
    if (skip !== undefined) {
      if (skip < 0) return out;
      i = skip;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      const inner = closing(text, i);
      if (inner < 0) return out;
      i = inner - 1;
    }
  }
  return out;
}

/** Alert names the code gives, each with the first place that names it (see the rule above). */
export function alertsInCode(
  root: string,
  code: readonly CodeFile[] = readCode(root),
): Map<string, CodeAlert> {
  const found = new Map<string, CodeAlert>();
  for (const { file, text } of code) {
    if (!text.includes("alert") && !text.includes("duty-stalled-")) continue;
    const add = (name: string, index: number) => {
      if (!found.has(name)) found.set(name, { file, line: lineAt(text, index) });
    };
    for (const match of text.matchAll(ALERTS_PROPERTY)) {
      const at = match.index + match[0].length;
      const c = text[at];
      if (c === "[") {
        for (const s of topLevelStrings(text, at)) add(s.value, s.at);
      } else if (c === '"' || c === "'" || c === "`") {
        const close = stringEnd(text, at);
        const value = close < 0 ? "" : text.slice(at + 1, close);
        if (value !== "" && !value.includes("${")) add(value, at);
      }
    }
    for (const match of text.matchAll(ALERT_PROSE)) {
      add(match[1] ?? match[2] ?? match[3] ?? "", match.index);
    }
  }
  return found;
}

function isDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const OWED_FILE = "ops/monitoring/catalog/owed.ts";
const LANE = /^(?:P0-[A-Z][0-9]?|L-[A-Z]{3,4}-[0-9]{2})$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * MC-15: every alert name the code or the catalogue gives is a rule of each environment or owed,
 * with a lane and a due date; an owed alert that has become a rule leaves the list.
 */
function checkOwed(
  fragments: Readonly<Record<string, readonly CatalogEntry[]>>,
  owed: readonly OwedAlert[],
  configs: readonly EnvConfig[],
  root: string,
  code: readonly CodeFile[] | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const owedNames = new Set<string>();
  for (const alert of owed) {
    const add = (message: string) =>
      findings.push({ file: OWED_FILE, rule: "MC-15", message: `${alert.name}: ${message}` });
    if (owedNames.has(alert.name)) add("is listed twice");
    owedNames.add(alert.name);
    if (!ALERT_NAME.test(alert.name)) add("is not an alert name (words joined by hyphens)");
    if (typeof alert.lane !== "string" || !LANE.test(alert.lane)) {
      add("names no lane (a lane of EXECUTION's tables, such as L-SAT-09)");
    }
    if (!isDate(alert.due)) add("has no due date (YYYY-MM-DD)");
    if (alert.severity !== "P" && alert.severity !== "N") add("severity must be P or N");
    if (typeof alert.fragment !== "string" || !SLUG.test(alert.fragment)) {
      add("names no fragment (ops/monitoring/<env>/alerts/<fragment>.json)");
    }
    if (typeof alert.spec !== "string" || alert.spec.trim() === "") add("names no spec section");
    if (alert.heartbeat !== undefined && !SLUG.test(alert.heartbeat)) {
      add(`its heartbeat ${String(alert.heartbeat)} is not a heartbeat name`);
    }
  }

  // The names the catalogue and the code give, each with where it is given: each entry's owed, every
  // alert-shaped word of its noAlert, and the fragment file's own text (its comments), read in the
  // forms code is read in and in the specs' `<name> (P|N` form.
  const named = new Map<string, { file: string; by: string }>();
  const entryOwes: { file: string; event: string; name: string }[] = [];
  const fragmentFiles: CodeFile[] = [];
  for (const [area, entries] of Object.entries(fragments)) {
    const file = `ops/monitoring/catalog/${area}.ts`;
    for (const entry of entries) {
      for (const name of entry.owed ?? []) {
        entryOwes.push({ file, event: entry.event, name });
        if (!named.has(name)) named.set(name, { file, by: `${entry.event} owes` });
      }
      for (const match of (entry.noAlert ?? "").matchAll(ALERT_WORD)) {
        const name = match[0];
        if (!named.has(name)) named.set(name, { file, by: `${entry.event}'s noAlert names` });
      }
    }
    if (existsSync(join(root, file))) {
      fragmentFiles.push({ file, text: readFileSync(join(root, file), "utf8") });
    }
  }
  const inFragments = alertsInCode(root, fragmentFiles);
  for (const { file, text } of fragmentFiles) {
    for (const match of text.matchAll(SEVERITY_NAMED)) {
      const name = match[1] ?? "";
      if (!inFragments.has(name)) inFragments.set(name, { file, line: lineAt(text, match.index) });
    }
  }
  for (const [name, at] of inFragments) {
    if (!named.has(name)) named.set(name, { file: `${at.file}:${at.line}`, by: "names" });
  }
  if (code !== undefined) {
    for (const [name, at] of alertsInCode(root, code)) {
      if (!named.has(name)) named.set(name, { file: `${at.file}:${at.line}`, by: "names" });
    }
  }

  for (const config of configs) {
    const defined = new Set(config.alerts.flatMap((a) => [a.name, a.template]));
    for (const [name, at] of named) {
      if (defined.has(name) || owedNames.has(name)) continue;
      findings.push({
        file: at.file,
        rule: "MC-15",
        message: `${at.by} the alert ${name}, which is no ${config.env} rule and is not listed in catalog/owed.ts with a lane and a date`,
      });
    }
    for (const alert of owed) {
      if (!defined.has(alert.name)) continue;
      findings.push({
        file: OWED_FILE,
        rule: "MC-15",
        message: `${alert.name} is a ${config.env} rule now: name it in its catalogue entries' alerts and drop it from the owed list`,
      });
    }
    for (const { file, event, name } of entryOwes) {
      if (!defined.has(name)) continue;
      findings.push({
        file,
        rule: "MC-15",
        message: `${event} owes ${name}, which is a ${config.env} rule now: name it in alerts`,
      });
    }
  }
  return findings;
}

function envDirs(root: string): string[] {
  const base = join(root, "ops", "monitoring");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => existsSync(join(base, name, "sources.json")))
    .sort();
}

function notifyFindings(file: string, what: string, notify: Notify | undefined): Finding[] {
  if (notify === undefined) return [];
  return NOTIFY_KEYS.filter((key) => notify[key] === true).map((key) => ({
    file,
    rule: "RT-03",
    message: `${what} asks for ${key}: staging stays quiet (email only)`,
  }));
}

function checkCatalogue(
  fragments: Readonly<Record<string, readonly CatalogEntry[]>>,
  root: string,
  code: readonly CodeFile[] | undefined,
): { findings: Finding[]; byEvent: Map<string, CatalogEntry> } {
  const findings: Finding[] = [];
  const byEvent = new Map<string, CatalogEntry>();
  for (const [area, entries] of Object.entries(fragments)) {
    const file = `ops/monitoring/catalog/${area}.ts`;
    for (const entry of entries) {
      if (byEvent.has(entry.event)) {
        findings.push({ file, rule: "MC-01", message: `${entry.event} is catalogued twice` });
      }
      byEvent.set(entry.event, entry);
      const kinds = kindsOf(entry);
      const watched = kinds.some((k) => k === "failure" || k === "security" || k === "money");
      const covered = entry.alerts.length > 0 || (entry.owed ?? []).length > 0;
      if (watched && !covered && (entry.noAlert ?? "").trim() === "") {
        findings.push({
          file,
          rule: "MC-02",
          message: `${entry.event} is ${kinds.join(" and ")} with no alert and no noAlert reason`,
        });
      }
      for (const name of Object.keys(entry.fields)) {
        if (ENVELOPE_FIELDS.includes(name)) {
          findings.push({
            file,
            rule: "MC-03",
            message: `${entry.event} redeclares the envelope field ${name}`,
          });
        }
      }
      for (const reason of entry.reasons ?? []) {
        if (!REASON_CODE.test(reason) || reason.length > 64) {
          findings.push({
            file,
            rule: "MC-03",
            message: `${entry.event}: reason ${reason} breaks the ReasonCode shape`,
          });
        }
      }
    }
  }
  const catalogDir = join(root, "ops", "monitoring", "catalog");
  if (existsSync(catalogDir)) {
    for (const name of readdirSync(catalogDir)) {
      const area = name.replace(/\.ts$/, "");
      if (!name.endsWith(".ts") || ["types", "index", "owed"].includes(area)) continue;
      if (!(area in fragments)) {
        findings.push({
          file: `ops/monitoring/catalog/${name}`,
          rule: "MC-01",
          message: "a catalogue fragment that catalog/index.ts does not list",
        });
      }
    }
  }
  for (const event of PHASE0_EVENTS) {
    if (!byEvent.has(event)) {
      findings.push({
        file: "ops/monitoring/catalog/platform.ts",
        rule: "MC-01",
        message: `spec 01 §8.9's event ${event} is not catalogued`,
      });
    }
  }
  if (code !== undefined) {
    const { found, refused } = scanWriters(code);
    for (const [event, at] of found) {
      if (!byEvent.has(event)) {
        findings.push({
          file: `${at.file}:${at.line}`,
          rule: "MC-01",
          message: `${at.call} is not catalogued`,
        });
      }
    }
    for (const at of refused) {
      findings.push({ file: `${at.file}:${at.line}`, rule: "MC-01", message: at.message });
    }
  }
  return { findings, byEvent };
}

function fieldsOf(entry: CatalogEntry | undefined): Set<string> {
  return new Set([...ENVELOPE_FIELDS, ...Object.keys(entry?.fields ?? {})]);
}

function checkAlert(
  alert: AlertDef,
  config: EnvConfig,
  byEvent: Map<string, CatalogEntry>,
  sourceNames: Set<string>,
  policyNames: Set<string>,
  root: string,
): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, message: string) =>
    findings.push({ file: alert.file, rule, message: `${alert.name}: ${message}` });
  const { template: _template, ...expanded } = alert;
  if (/(?<!\{)\{[a-z]+\}(?!\})/.test(JSON.stringify(expanded))) {
    add("MC-00", "an unexpanded {placeholder} remains (forEach does not provide it)");
  }
  if (alert.severity !== "P" && alert.severity !== "N") add("MC-00", "severity must be P or N");
  if (!Array.isArray(alert.sources) || alert.sources.length === 0) {
    add("MC-00", "names no source");
  }
  for (const source of alert.sources ?? []) {
    if (!sourceNames.has(source)) add("MC-07", `names the source ${source}, which does not exist`);
  }
  // Routing.
  if (alert.policy === undefined || alert.policy === "") add("RT-01", "has no policy");
  else if (config.env === "staging" && alert.policy !== QUIET_POLICY) {
    add(alert.policy.startsWith("production-") ? "MC-13" : "RT-01", `routes to ${alert.policy}`);
  } else if (!policyNames.has(alert.policy)) add("RT-01", `names an undefined policy`);
  for (const key of NOTIFY_KEYS) {
    if (alert[key] === true) add("RT-03", `asks for ${key}: staging stays quiet`);
  }
  // Metadata and runbook.
  if ((alert.incident_cause ?? "").trim() === "") add("MC-08", "has no incident_cause");
  const meta = alert.metadata ?? {};
  for (const key of ["check", "flow", "runbook"]) {
    if ((meta[key] ?? "").trim() === "") add("MC-08", `has no metadata.${key}`);
  }
  const flow = meta.flow ?? "";
  if (flow !== "" && !FLOW_ID.test(flow)) add("MC-08", `metadata.flow ${flow} is not a flow ID`);
  const atlas = join(root, "docs", "flows", "atlas.json");
  if (flow !== "" && existsSync(atlas) && !readFileSync(atlas, "utf8").includes(`"${flow}"`)) {
    add("MC-08", `metadata.flow ${flow} is not in docs/flows/atlas.json`);
  }
  const runbook = meta.runbook ?? "";
  if (runbook !== "" && (!runbook.startsWith("docs/runbooks/") || !runbook.endsWith(".md"))) {
    add("MC-08", "metadata.runbook must be a docs/runbooks/*.md path");
  } else if (runbook !== "" && !existsSync(join(root, runbook))) {
    add("MC-08", `its runbook ${runbook} does not exist`);
  }
  // Thresholds name overlay keys.
  if (typeof alert.threshold !== "string" || !THRESHOLD.test(alert.threshold)) {
    add("MC-11", "threshold must be @any, @none or an @thresholds.<key> overlay key");
  } else if (alert.threshold === "@any" && alert.operator !== "higher_than") {
    add("MC-00", "@any needs the operator higher_than");
  } else if (alert.threshold === "@none" && alert.operator !== "lower_than") {
    add("MC-00", "@none needs the operator lower_than");
  }
  if (alert.window !== undefined && overlayKeys(alert.window).length !== 1) {
    add("MC-11", "window must be an @thresholds.<key> overlay key");
  }
  if (alert.window === undefined && typeof alert.query_period !== "number") {
    add("MC-00", "needs a query_period or a window");
  }
  if ("ratio" in alert.query && overlayKeys(`@${alert.query.ratio.minCount}`).length === 0) {
    add("MC-11", "ratio.minCount must be an @thresholds.<key> overlay key");
  }
  // The catalogue.
  for (const event of queryEvents(alert.query)) {
    const entry = byEvent.get(event);
    if (entry === undefined) {
      add("MC-04", `reads the event ${event}, which is not catalogued`);
      continue;
    }
    if (!entry.alerts.includes(alert.template)) {
      add("MC-04", `watches ${event}, whose catalogue entry does not name ${alert.template}`);
    }
  }
  const events = queryEvents(alert.query);
  const declared = new Set(events.flatMap((e) => [...fieldsOf(byEvent.get(e))]));
  const series = seriesFields(alert) ?? [];
  for (const name of [...queryFields(alert.query), ...series]) {
    if (events.length > 0 && !declared.has(name)) {
      add("MC-04", `reads the field ${name}, which no watched event declares`);
    }
  }
  // An event whose lines tell failures apart only by several fields together is grouped by all
  // of them, or a failure that stands joins the incident a later, different one should open.
  for (const event of events) {
    const want = byEvent.get(event)?.seriesBy;
    if (want === undefined || want.join("/") === series.join("/")) continue;
    add(
      "MC-04",
      `groups ${event} by ${series.length === 0 ? "nothing" : series.join(", ")}, not by ${want.join(", ")}, so a failure that stands never hides a later, different one`,
    );
  }
  // A security alert must fail closed: `eq: false` needs the field on the line, so a line
  // without it (a matcher that could not decide, a writer that regressed) would never alert.
  const security = events.filter((e) => {
    const entry = byEvent.get(e);
    return entry !== undefined && kindsOf(entry).includes("security");
  });
  for (const c of queryConditions(alert.query)) {
    if (c.eq !== false || security.length === 0) continue;
    add(
      "MC-04",
      `filters the security event ${security.join(", ")} with ${c.field} eq false, so a line without ${c.field} never alerts; use notEq true`,
    );
  }
  try {
    const numbers: Record<string, number> = {};
    if ("ratio" in alert.query) numbers[alert.query.ratio.minCount] = 1;
    renderSql(alert, numbers);
  } catch (error) {
    add(
      "MC-04",
      `its query cannot be rendered (${error instanceof QueryError ? error.message : "error"})`,
    );
  }
  return findings;
}

function checkRunbook(root: string, path: string, names: readonly string[]): Finding[] {
  const full = join(root, path);
  if (!existsSync(full)) return [];
  const text = readFileSync(full, "utf8");
  const findings: Finding[] = [];
  for (const heading of RUNBOOK_HEADINGS) {
    if (!text.split("\n").some((line) => line.trim() === heading)) {
      findings.push({ file: path, rule: "MC-10", message: `lacks the heading "${heading}"` });
    }
  }
  for (const name of names) {
    if (!text.includes(`\`${name}\``)) {
      findings.push({
        file: path,
        rule: "MC-10",
        message: `does not name ${name}, which points at it`,
      });
    }
  }
  return findings;
}

function checkIdentifiers(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const shape of IDENTIFIER_SHAPES) {
      if (shape.pattern.test(line)) {
        findings.push({
          file: `${file}:${index + 1}`,
          rule: "MC-12",
          message: `holds what looks like a Better Stack ${shape.name}`,
        });
      }
    }
  }
  return findings;
}

function checkEnv(config: EnvConfig, byEvent: Map<string, CatalogEntry>, root: string): Finding[] {
  const findings: Finding[] = [];
  const base = `ops/monitoring/${config.env}`;
  const { sources, errors, metrics, monitors, heartbeats, policies } = config;
  const sourceNames = new Set(sources.sources.map((s) => s.service));

  // MC-13: the files are the environment's own. The apply checks the tokens' team against
  // `fin-<env>`, never against a string in the files it is applying.
  const team = `fin-${config.env}`;
  const prefix = `fin-next-${config.env}-`;
  for (const [file, value] of [
    ["sources.json", sources.team],
    ["policies.json", policies.team],
  ] as const) {
    if (value !== team) {
      findings.push({
        file: `${base}/${file}`,
        rule: "MC-13",
        message: `names the team ${String(value)}; the ${config.env} files belong to ${team}`,
      });
    }
  }
  if (sources.environment !== config.env) {
    findings.push({
      file: `${base}/sources.json`,
      rule: "MC-13",
      message: `names the environment ${String(sources.environment)}, not ${config.env}`,
    });
  }
  for (const [file, value] of [
    ["sources.json", sources.namePrefix],
    ["errors.json", errors.namePrefix],
  ] as const) {
    if (value !== prefix) {
      findings.push({
        file: `${base}/${file}`,
        rule: "MC-13",
        message: `names the prefix ${String(value)}; the ${config.env} files use ${prefix}`,
      });
    }
  }

  // MC-07: a secret goes only to a Railway service, as a sealed variable (spec 08 §7.11).
  const holders: { file: string; what: string; services: unknown }[] = [
    ...sources.sources.map((s) => ({
      file: "sources.json",
      what: `source ${s.service}`,
      services: s.holders ?? [s.service],
    })),
    ...errors.applications.map((a) => ({
      file: "errors.json",
      what: `application ${a.name}`,
      services: a.holders,
    })),
    ...heartbeats.heartbeats.map((h) => ({
      file: "heartbeats.json",
      what: `heartbeat ${h.name}`,
      services: h.holders,
    })),
  ];
  for (const holder of holders) {
    if (!Array.isArray(holder.services)) {
      // errors.json's own shape rule below reports an application's.
      if (holder.file !== "errors.json") {
        findings.push({
          file: `${base}/${holder.file}`,
          rule: "MC-00",
          message: `${holder.what}: holders must list the Railway services that receive its secret`,
        });
      }
      continue;
    }
    for (const service of holder.services) {
      if (!RAILWAY_SERVICES.includes(String(service))) {
        findings.push({
          file: `${base}/${holder.file}`,
          rule: "MC-07",
          message: `${holder.what} delivers its secret to ${String(service)}, which is not a Railway service`,
        });
      }
    }
  }

  // MC-05: every heartbeat of spec 01 §8.5, and the one the watcher pings, is defined. A dropped
  // heartbeat is paused by the apply, so a missing one silences a dead-man switch.
  const heartbeatNames = new Set(heartbeats.heartbeats.map((h) => h.name));
  for (const name of PHASE0_HEARTBEATS) {
    if (!heartbeatNames.has(name)) {
      findings.push({
        file: `${base}/heartbeats.json`,
        rule: "MC-05",
        message: `spec 01 §8.5's heartbeat ${name} is missing`,
      });
    }
  }
  const watcherSettings = join(root, "ops", "watcher", "settings", `${config.env}.json`);
  if (existsSync(watcherSettings)) {
    let pinged: unknown;
    try {
      pinged = (JSON.parse(readFileSync(watcherSettings, "utf8")) as { heartbeat?: unknown })
        .heartbeat;
    } catch {
      pinged = undefined;
    }
    if (typeof pinged !== "string" || !heartbeatNames.has(pinged)) {
      findings.push({
        file: `ops/watcher/settings/${config.env}.json`,
        rule: "MC-05",
        message: `the watcher's settings ping the heartbeat ${String(pinged)}, which heartbeats.json does not define`,
      });
    }
  }

  // MC-07: every source has an Errors application or a written reason.
  const covered = new Set<string>();
  for (const app of errors.applications) {
    if (app.source !== undefined) {
      if (!sourceNames.has(app.source)) {
        findings.push({
          file: `${base}/errors.json`,
          rule: "MC-07",
          message: `${app.name} correlates with ${app.source}, which is not a source`,
        });
      }
      covered.add(app.source);
    }
    for (const user of app.alsoUsedBy ?? []) covered.add(user);
    if (!Array.isArray(app.holders) || typeof app.variable !== "string") {
      findings.push({
        file: `${base}/errors.json`,
        rule: "MC-00",
        message: `${app.name}: needs holders and variable (where its DSN is delivered)`,
      });
    }
    if (!/_errors$/.test(app.platform)) {
      findings.push({
        file: `${base}/errors.json`,
        rule: "MC-00",
        message: `${app.name}: an Errors platform ends in _errors`,
      });
    }
  }
  const reasons = errors.noApplication ?? {};
  for (const source of sourceNames) {
    if (!covered.has(source) && (reasons[source] ?? "").trim() === "") {
      findings.push({
        file: `${base}/errors.json`,
        rule: "MC-07",
        message: `the source ${source} has no Errors application and no reason`,
      });
    }
  }

  // MC-06 and MC-07 for metrics.
  for (const name of Object.keys(metrics.sources)) {
    if (!sourceNames.has(name)) {
      findings.push({
        file: `${base}/metrics.json`,
        rule: "MC-07",
        message: `metrics for ${name}, which is not a source`,
      });
    }
    for (const set of metrics.sources[name] ?? []) {
      if (!(set in metrics.sets)) {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-00",
          message: `${name} names the unknown set ${set}`,
        });
      }
    }
  }
  const allFields = new Set<string>(ENVELOPE_FIELDS);
  for (const entry of byEvent.values()) for (const f of Object.keys(entry.fields)) allFields.add(f);
  for (const [set, defs] of Object.entries(metrics.sets)) {
    for (const metric of defs) {
      if (!METRIC_TYPES.includes(metric.type)) {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-00",
          message: `${set}.${metric.name}: type ${String(metric.type)} is not a Better Stack metric type`,
        });
      }
      const label = metric.aggregations.length === 0;
      if (label && ID_SHAPED_FIELD.test(metric.field)) {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-06",
          message: `${set}.${metric.name}: the label ${metric.field} is ID-shaped or free text`,
        });
      }
      if (label && metric.type !== "string_low_cardinality") {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-06",
          message: `${set}.${metric.name}: a label is string_low_cardinality`,
        });
      }
      if (!allFields.has(metric.field)) {
        findings.push({
          file: `${base}/metrics.json`,
          rule: "MC-04",
          message: `${set}.${metric.name} reads ${metric.field}, which no catalogued event declares`,
        });
      }
    }
  }

  // Policies: staging-quiet exists and is email only (RT-02).
  const policyNames = new Set(policies.policies.map((p) => p.name));
  const severities = new Map(policies.severities.map((s) => [s.name, s]));
  if (policies.team !== sources.team) {
    findings.push({
      file: `${base}/policies.json`,
      rule: "RT-01",
      message: "the policies' team differs from the sources' team",
    });
  }
  if (config.env === "staging") {
    if (!policyNames.has(QUIET_POLICY)) {
      findings.push({ file: `${base}/policies.json`, rule: "RT-01", message: "no staging-quiet" });
    }
    for (const policy of policies.policies) {
      if (policy.name !== QUIET_POLICY) {
        findings.push({
          file: `${base}/policies.json`,
          rule: policy.name.startsWith("production-") ? "MC-13" : "RT-01",
          message: `staging defines ${policy.name}; staging has staging-quiet only`,
        });
      }
    }
  }
  for (const policy of policies.policies) {
    const file = `${base}/policies.json`;
    if (config.env === "staging" && (policy.repeatCount !== 0 || policy.steps.length !== 1)) {
      findings.push({ file, rule: "RT-02", message: `${policy.name} escalates or repeats` });
    }
    for (const step of policy.steps) {
      const members = Array.isArray(step.members) ? step.members : [];
      // Spec 08 §7.9: one step, at once, to the entire staging team. Every staging alert,
      // monitor and heartbeat routes here, so a wait or other members would quiet them all.
      if (config.env === "staging") {
        if (step.waitBefore !== 0) {
          findings.push({
            file,
            rule: "RT-02",
            message: `${policy.name}: its step must notify at once (waitBefore 0)`,
          });
        }
        const onlyTeam =
          members.length === 1 &&
          members[0]?.type === "entire_team" &&
          members[0]?.id === undefined;
        if (!onlyTeam) {
          findings.push({
            file,
            rule: "RT-02",
            message: `${policy.name}: its step must reach the entire staging team and no one else`,
          });
        }
      }
      const severity = severities.get(step.severity);
      if (severity === undefined) {
        findings.push({ file, rule: "RT-02", message: `${policy.name}: unknown severity` });
      } else if (config.env === "staging") {
        findings.push(...notifyFindings(file, `severity ${severity.name}`, severity));
        if (severity.email !== true) {
          findings.push({
            file,
            rule: "RT-02",
            message: `severity ${severity.name} sends no email`,
          });
        }
      }
      for (const member of members) {
        if (member.type === "ai_sre") {
          findings.push({ file, rule: "RT-02", message: `${policy.name} has an ai_sre member` });
        }
      }
    }
  }

  // Alerts.
  const seen = new Map<string, string>();
  const runbookUsers = new Map<string, string[]>();
  const point = (runbook: string | undefined, name: string) => {
    if (runbook === undefined || runbook === "") return;
    runbookUsers.set(runbook, [...(runbookUsers.get(runbook) ?? []), name]);
  };
  for (const alert of config.alerts) {
    const other = seen.get(alert.name);
    if (other !== undefined) {
      findings.push({
        file: alert.file,
        rule: "MC-14",
        message: `${alert.name} is also defined in ${other}`,
      });
    }
    seen.set(alert.name, alert.file);
    findings.push(...checkAlert(alert, config, byEvent, sourceNames, policyNames, root));
    point(alert.metadata?.runbook, alert.template);
  }
  const templates = new Set(config.alerts.map((a) => a.template));
  for (const entry of byEvent.values()) {
    for (const name of entry.alerts) {
      if (!templates.has(name)) {
        findings.push({
          file: "ops/monitoring/catalog",
          rule: "MC-04",
          message: `${entry.event} names the alert ${name}, which no ${config.env} fragment defines`,
        });
      }
    }
  }

  // Monitors and heartbeats: policy, quiet, runbook.
  const objects = [
    ...monitors.monitors.map((m) => ({
      file: `${base}/monitors.json`,
      what: `monitor ${m.name}`,
      name: m.name,
      policy: m.policy ?? monitors.defaults.policy,
      notify: { ...monitors.defaults.notify, ...m.notify },
      runbook: m.runbook ?? monitors.defaults.runbook,
    })),
    ...heartbeats.heartbeats.map((h) => ({
      file: `${base}/heartbeats.json`,
      what: `heartbeat ${h.name}`,
      name: h.name,
      policy: h.policy ?? heartbeats.defaults.policy,
      notify: { ...heartbeats.defaults.notify, ...h.notify },
      runbook: h.runbook ?? heartbeats.defaults.runbook,
    })),
  ];
  for (const object of objects) {
    if (object.policy === undefined || object.policy === "") {
      findings.push({ file: object.file, rule: "RT-01", message: `${object.what} has no policy` });
    } else if (config.env === "staging" && object.policy !== QUIET_POLICY) {
      findings.push({
        file: object.file,
        rule: object.policy.startsWith("production-") ? "MC-13" : "RT-01",
        message: `${object.what} routes to ${object.policy}`,
      });
    } else if (!policyNames.has(object.policy)) {
      findings.push({
        file: object.file,
        rule: "RT-01",
        message: `${object.what}: unknown policy`,
      });
    }
    if (config.env === "staging")
      findings.push(...notifyFindings(object.file, object.what, object.notify));
    if (!existsSync(join(root, object.runbook))) {
      findings.push({
        file: object.file,
        rule: "MC-08",
        message: `${object.what}: its runbook ${object.runbook} does not exist`,
      });
    }
    point(object.runbook, object.name);
  }
  for (const monitor of monitors.monitors) {
    if (/[./]/.test(monitor.host) || !/^[a-z]+$/.test(monitor.host)) {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: host must be a host role, never a hostname`,
      });
    }
    if (!monitor.path.startsWith("/")) {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: path must start with /`,
      });
    }
    if (monitor.type === "keyword" && (monitor.keyword ?? "") === "") {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: a keyword monitor needs its keyword`,
      });
    }
    if (monitor.type === "expected_status_code" && (monitor.expectStatus ?? []).length === 0) {
      findings.push({
        file: `${base}/monitors.json`,
        rule: "MC-00",
        message: `monitor ${monitor.name}: needs expectStatus`,
      });
    }
  }
  for (const heartbeat of heartbeats.heartbeats) {
    if (!/^@grace\.[a-z0-9-]+$/.test(String(heartbeat.grace))) {
      findings.push({
        file: `${base}/heartbeats.json`,
        rule: "MC-11",
        message: `heartbeat ${heartbeat.name}: grace must be an @grace.<key> overlay key`,
      });
    }
  }

  // MC-10: each runbook has the headings and names who points at it.
  for (const [runbook, names] of runbookUsers) {
    findings.push(...checkRunbook(root, runbook, [...new Set(names)]));
  }
  return findings;
}

/** MC-12 over every file under the given paths (files or directories), each file once. */
function scanIdentifiers(root: string, paths: readonly string[]): Finding[] {
  const files = new Set<string>();
  for (const path of paths) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) {
      const found: string[] = [];
      walk(root, path, found);
      for (const file of found) files.add(file);
    } else files.add(path);
  }
  const findings: Finding[] = [];
  for (const file of [...files].sort()) {
    findings.push(...checkIdentifiers(file, readFileSync(join(root, file), "utf8")));
  }
  return findings;
}

/** Runs every rule. Returns the findings, empty when the files pass. */
export function checkMonitoring(root: string, options: CheckOptions = {}): Finding[] {
  const fragments = options.fragments ?? defaultFragments;
  // The code is read once, for both scans (MC-01 and MC-15).
  const code = (options.scanCode ?? true) ? readCode(root) : undefined;
  const { findings, byEvent } = checkCatalogue(fragments, root, code);
  const envs = options.envs ?? envDirs(root);
  if (envs.length === 0) {
    findings.push({ file: "ops/monitoring", rule: "MC-00", message: "no environment files" });
  }
  const configs: EnvConfig[] = [];
  for (const env of envs) {
    const loaded = loadEnv(root, env);
    findings.push(...loaded.findings);
    if (loaded.config === undefined) continue;
    configs.push(loaded.config);
    findings.push(...checkEnv(loaded.config, byEvent, root));
  }
  findings.push(...checkOwed(fragments, options.owed ?? OWED_ALERTS, configs, root, code));
  // MC-12 over every file, not only those the loader parses: each environment's whole directory
  // (dashboards, webhooks and the status page included), the catalogue, the README and the
  // runbooks, and the watcher's settings.
  findings.push(
    ...scanIdentifiers(root, [
      ...envs.map((env) => `ops/monitoring/${env}`),
      "ops/monitoring/catalog",
      "ops/monitoring/README.md",
      ...(options.scan ?? ["ops/watcher/settings", "docs/runbooks"]),
    ]),
  );
  return findings;
}

/** Formats findings one per line: where, the rule, the message. Never a value from a secret. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.file}: ${f.rule} ${f.message}`).join("\n");
}
