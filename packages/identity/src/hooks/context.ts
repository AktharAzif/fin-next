// The narrow view of Better Auth's endpoint context that Fin's hooks use. The library's own types
// are generic over every plugin; the hooks read only these fields, and SP-10's pin tests prove
// the shapes on the installed version.

export interface LibrarySession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  [field: string]: unknown;
}

export interface LibraryUser {
  id: string;
  email: string;
  name: string;
  [field: string]: unknown;
}

export interface AuthContextView {
  secret: string;
  secretConfig: unknown;
  authCookies: { sessionToken: { name: string } };
  /** The full name of one of the library's cookies (the realm's prefix applied). */
  createAuthCookie(name: string): { name: string };
  internalAdapter: {
    /** A verification row by its identifier, read without consuming it. */
    findVerificationValue(
      identifier: string,
    ): Promise<{ value: string; expiresAt: Date | string } | null>;
  };
  returned?: unknown;
  newSession?: { session: LibrarySession; user: LibraryUser } | null;
}

export interface HookContext {
  path: string;
  method?: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Headers;
  request?: Request;
  context: AuthContextView;
  getCookie(name: string): string | null;
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
  setCookie(name: string, value: string, options: Record<string, unknown>): string;
}

export function headersOf(ctx: HookContext): Headers {
  return ctx.headers ?? ctx.request?.headers ?? new Headers();
}

export function bodyOf(ctx: HookContext): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null || typeof ctx.body !== "object") return {};
  return ctx.body;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A Fin browser token from a cookie, or null when absent or malformed. */
export function tokenCookie(ctx: HookContext, name: string): string | null {
  const value = ctx.getCookie(name);
  return value !== null && TOKEN.test(value) ? value : null;
}
