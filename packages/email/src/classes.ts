// The email classes and `defineTemplate` (spec 08 §4.1, §4.2; ARCHITECTURE §8.7, §9.4 to §9.6).
//
// Every template declares its class, and the class fixes the sending subdomain, the outbox
// priority, what happens past the recipient's allowance and whether the row bears a secret. A
// template's subject, heading and preview are Fin's own fixed words: `render` may choose among fixed
// phrases by an enumerated parameter (a kind, a mode), but typed values (names, devices) reach the
// message only through labelled boxes in the body, escaped by the layout (T08-20).
import type { z } from "zod";

export const EMAIL_CLASSES = ["code", "security", "notice", "customer", "ops"] as const;
export type EmailClass = (typeof EMAIL_CLASSES)[number];

/** The two sending subdomains per zone ([EM-08]). */
export type Subdomain = "auth" | "notify";

export interface ClassRule {
  readonly subdomain: Subdomain;
  /** The outbox priority: lower is claimed first (codes, then security notices). */
  readonly priority: number;
  /** Whether rows of the class bear a secret by default (a code or a link token). */
  readonly secretBearing: boolean;
  /** What happens past the recipient's allowance at the sender. */
  readonly pastAllowance: "refused_at_ask" | "digest" | "refused_at_action" | "unlimited";
  /** Whether the class may use the daily budget's reserved share (spec 08 §4.2, ARCHITECTURE §9.5). */
  readonly reservedShare: boolean;
}

export const CLASS_RULES: Readonly<Record<EmailClass, ClassRule>> = Object.freeze({
  code: {
    subdomain: "auth",
    priority: 1,
    secretBearing: true,
    pastAllowance: "refused_at_ask",
    reservedShare: true,
  },
  security: {
    subdomain: "auth",
    priority: 2,
    secretBearing: false,
    pastAllowance: "digest",
    reservedShare: true,
  },
  notice: {
    subdomain: "notify",
    priority: 3,
    secretBearing: false,
    pastAllowance: "refused_at_action",
    reservedShare: false,
  },
  customer: {
    subdomain: "notify",
    priority: 3,
    secretBearing: true,
    pastAllowance: "refused_at_action",
    reservedShare: false,
  },
  ops: {
    subdomain: "auth",
    priority: 4,
    secretBearing: false,
    pastAllowance: "unlimited",
    reservedShare: true,
  },
});

/** The highest priority number that counts as urgent (codes and security notices). */
export const URGENT_PRIORITY = 2;

/** The template folders (spec 08 §4.4). Each folder has one owning lane. */
export const TEMPLATE_AREAS = [
  "identity",
  "orgs",
  "api-keys",
  "webhooks",
  "kyc",
  "golive",
  "staff",
  "staff-kyc",
  "money",
  "ops",
] as const;
export type TemplateArea = (typeof TEMPLATE_AREAS)[number];

/** Which realm a template's reader belongs to, for its one link. */
export type Realm = "developer" | "staff" | "customer" | "ops";

/** The host roles a template may link to; real origins come from configuration. */
export type LinkHost = "console" | "admin" | "verify";

export interface LinkOrigins {
  readonly console?: string;
  readonly admin?: string;
  readonly verify?: string;
}

/** A labelled box: the only place a typed or variable value appears. */
export interface Box {
  readonly label: string;
  readonly value: string;
}

export interface Link {
  readonly label: string;
  readonly host: LinkHost;
  /** A path on the host, starting with `/`. A fragment may carry a code (spec 02 §5.2). */
  readonly path: string;
}

/** What a template's `render` returns: fixed words plus boxes, at most one link, no image. */
export interface Content {
  readonly subject: string;
  readonly heading: string;
  readonly preview: string;
  readonly paragraphs: readonly string[];
  /** A one-time code, shown large in its own labelled box. Only `code` class templates. */
  readonly code?: string;
  readonly boxes?: readonly Box[];
  readonly link?: Link;
  /** Fixed closing lines, such as "If this wasn't you, ...". */
  readonly footer?: readonly string[];
}

export interface RenderContext {
  /** The resolved recipient address, for a sign-in link's fragment only. */
  readonly recipient: string;
  /** The environment's name, for the delivery check. */
  readonly environment: string;
  /** The digest's fixed line for a template, from the catalogue. */
  readonly describe: (template: string) => string | undefined;
}

export interface TemplateSpec<S extends z.ZodType> {
  readonly name: string;
  readonly area: TemplateArea;
  readonly class: EmailClass;
  readonly subdomain: Subdomain;
  readonly realm: Realm;
  /** True when the row carries a code or a link token: deleted on send, left out of dumps. */
  readonly secretBearing: boolean;
  /** Always sent on its own, never folded into a digest; still counts (spec 08 §4.3). */
  readonly bypassLimits: boolean | ((params: z.output<S>) => boolean);
  /** How long a code-bearing row is worth sending (the code's life, spec 02 §5.2). */
  readonly codeTtlMs?: number;
  /** For `security` templates: the digest's one fixed line for this kind (spec 08 §4.3). */
  readonly digestLine?: string;
  readonly params: S;
  readonly sample: z.input<S>;
  readonly render: (params: z.output<S>, context: RenderContext) => Content;
}

export interface Template<S extends z.ZodType = z.ZodType> extends TemplateSpec<S> {
  /** `<area>/<name>`, as `email.enqueue()` and the lines name it. */
  readonly id: string;
  readonly priority: number;
  /** Validates the row's params and tells whether this row may be folded into a digest. */
  readonly bypasses: (params: unknown) => boolean;
}

const NAME = /^[a-z][a-z0-9-]{1,62}$/;

export class TemplateDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateDefinitionError";
  }
}

/** Declares a template and checks that its declaration agrees with its class. */
export function defineTemplate<S extends z.ZodType>(spec: TemplateSpec<S>): Template<S> {
  const rule = CLASS_RULES[spec.class];
  if (!NAME.test(spec.name)) throw new TemplateDefinitionError(`bad template name: ${spec.name}`);
  if (spec.subdomain !== rule.subdomain) {
    throw new TemplateDefinitionError(
      `${spec.area}/${spec.name}: ${spec.class} sends from ${rule.subdomain}`,
    );
  }
  if (spec.class === "code" && (!spec.secretBearing || spec.codeTtlMs === undefined)) {
    throw new TemplateDefinitionError(
      `${spec.area}/${spec.name}: a code template bears its code and has a life`,
    );
  }
  if (spec.class === "security" && spec.digestLine === undefined) {
    throw new TemplateDefinitionError(
      `${spec.area}/${spec.name}: a security template needs its digest line`,
    );
  }
  if (spec.class !== "security" && spec.bypassLimits !== false) {
    throw new TemplateDefinitionError(
      `${spec.area}/${spec.name}: only security templates bypass limits`,
    );
  }
  const bypass = spec.bypassLimits;
  return Object.freeze({
    ...spec,
    id: `${spec.area}/${spec.name}`,
    priority: rule.priority,
    bypasses: (params: unknown): boolean => {
      if (typeof bypass === "boolean") return bypass;
      const parsed = spec.params.safeParse(params);
      // A row whose params do not parse is refused before sending; it never folds.
      return parsed.success ? bypass(parsed.data) : true;
    },
  });
}
