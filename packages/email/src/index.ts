// @fin/email: EmailPort and the Cloudflare adapter, the template classes and catalogue, the outbox
// store and the one sender (ARCHITECTURE §9; spec 08 §4).

export {
  describe,
  findTemplate,
  type GrantRow,
  grantInsertSql,
  grantRows,
  ROLE_RULES,
  rolesFor,
  SENDER_ROLES,
  type SenderRole,
  TEMPLATES,
} from "./catalogue.ts";
export {
  CLASS_RULES,
  type Content,
  defineTemplate,
  EMAIL_CLASSES,
  type EmailClass,
  type LinkOrigins,
  type RenderContext,
  type Subdomain,
  type Template,
  URGENT_PRIORITY,
} from "./classes.ts";
export { CLOUDFLARE_ALLOWED, checkHeaders, finHeaders, HeaderRefused } from "./headers.ts";
export { EMAIL_ID, newId } from "./ids.ts";
export { type ClientLike, inTransaction, type PoolLike, type Queryable } from "./outbox/db.ts";
export {
  BucketMissing,
  type EnqueueInput,
  EnqueueRefused,
  enqueue,
  type OutboxAge,
  type OutboxRow,
  outboxAge,
  type RecipientKind,
} from "./outbox/store.ts";
export {
  formatTime,
  HIDDEN_VALUE,
  NAME_SECRET_SHAPES,
  nameSecretShapeIn,
  param,
  SECRET_SHAPES,
  type SecretShape,
  secretShapeIn,
} from "./params.ts";
export type {
  EmailPort,
  FailureKind,
  Mailbox,
  OutgoingEmail,
  ProviderLog,
  SendOutcome,
} from "./port.ts";
export {
  AdapterConfigError,
  type CloudflareAdapterOptions,
  CloudflareEmailAdapter,
  PROVIDER as CLOUDFLARE_PROVIDER,
} from "./providers/cloudflare/adapter.ts";
export { HOSTS as CLOUDFLARE_HOSTS } from "./providers/cloudflare/hosts.ts";
export {
  type LimitKey,
  normaliseAddress,
  type RecipientHasher,
  recipientHasher,
} from "./recipient-key.ts";
export { escapeHtml, RenderError, type Rendered, renderTemplate } from "./render.ts";
export {
  type BudgetGroup,
  type BudgetRefusal,
  type BudgetShare,
  backoffMs,
  budgetRefusal,
  budgetScopes,
  checkLimits,
  DEFAULT_LIMITS,
  type SenderLimits,
} from "./sender/limits.ts";
export {
  type BatchResult,
  type EmailLog,
  type Level,
  type RecipientResolver,
  Sender,
  type SenderOptions,
  type SentInfo,
} from "./sender/sender.ts";
