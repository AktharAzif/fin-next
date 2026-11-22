// The part of node-postgres' API the console's API half and the identity realm it runs use. `pg`
// ships no types and `@types/pg` is not in the approved dependency set (DECISIONS G-06), so the
// shapes are declared here, narrowly, as packages/identity declares them, with the TLS settings the
// console's pool needs. packages/db declares the same module differently, so the console cannot
// import @fin/db beside @fin/identity in one program; one shared declaration is recorded in the
// pull request.
declare module "pg" {
  export interface TlsSettings {
    ca?: string;
    servername?: string;
    rejectUnauthorized?: boolean;
  }
  export interface FieldDef {
    name: string;
    dataTypeID: number;
  }
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
    command: string;
    fields: FieldDef[];
  }
  export interface QueryConfig {
    text: string;
    name?: string;
    rowMode?: "array";
    values?: readonly unknown[];
    types?: unknown;
  }
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    application_name?: string;
    user?: string;
    password?: string | (() => string | Promise<string>);
    database?: string;
    host?: string;
    port?: number;
    options?: string;
    ssl?: false | TlsSettings;
    query_timeout?: number;
    maxLifetimeSeconds?: number;
  }
  export interface PoolClient {
    query<R = Record<string, unknown>>(
      text: string | QueryConfig,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    release(error?: Error | boolean): void;
  }
  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    query<R = Record<string, unknown>>(
      text: string | QueryConfig,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
    on(event: "error", listener: (error: Error) => void): this;
    readonly totalCount: number;
    readonly idleCount: number;
  }
  export class Client {
    constructor(config?: PoolConfig);
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(
      text: string | QueryConfig,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
  export interface DatabaseError extends Error {
    code?: string;
    table?: string;
    schema?: string;
    constraint?: string;
  }
  const pg: {
    Pool: typeof Pool;
    Client: typeof Client;
  };
  export default pg;
}
