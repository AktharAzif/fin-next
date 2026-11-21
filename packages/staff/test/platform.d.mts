// Types of platform.mjs (see its header for why it is JavaScript). Plain shapes only: nothing here
// names a `pg` type, so a program that imports @fin/identity can use it.

export interface PlatformClient {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
  end(): Promise<void>;
}

export interface StaffPlatform {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** A login's test password (derived from its name, as @fin/db's test bootstrap sets it). */
  password(login: string): string;
  /** A superuser connection: fixtures and assertions only, never the code under test. */
  superuser(): Promise<PlatformClient>;
  /** A fin_owner connection, as an operator task runs. */
  owner(): Promise<PlatformClient>;
  drop(): Promise<void>;
}

export interface EventTypeRow {
  name: string;
  area: string;
  category: string;
  scope: string;
  roles: string[];
  journal_kind: string | null;
  retired: boolean;
}

export function createStaffPlatform(prefix: string): Promise<StaffPlatform>;
export function eventTypes(): EventTypeRow[];
