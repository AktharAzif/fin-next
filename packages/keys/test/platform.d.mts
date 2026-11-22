// Types of platform.mjs (see its header for why it is JavaScript). Plain shapes only: nothing here
// names a `pg` type, so a program that imports @fin/identity can use it.

export interface PlatformClient {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
  end(): Promise<void>;
}

export interface KeysPlatform {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  /** A login's test password (derived from its name, as @fin/db's test bootstrap sets it). */
  password(login: string): string;
  /** A superuser connection: fixtures and assertions only, never the code under test. */
  superuser(): Promise<PlatformClient>;
  /** A connection as a login (`fin_console_a`, `fin_edge_a`, ...). */
  login(login: string, applicationName?: string): Promise<PlatformClient>;
  drop(): Promise<void>;
}

export interface SeedPerson {
  userId: string;
  memberId: string;
  name: string;
  email: string;
  roleKey: string;
}

export interface SeedOrganization {
  orgId: string;
  name: string;
  liveStatus?: string;
  people: SeedPerson[];
}

export function createKeysPlatform(prefix: string): Promise<KeysPlatform>;
export function seedOrganization(superuser: PlatformClient, seed: SeedOrganization): Promise<void>;
