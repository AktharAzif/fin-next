// Type declarations for the parts of `pg` 8.23.1 Fin uses. `pg` ships no types and `@types/pg` is not
// in DECISIONS G-06's approved set, so the surface Fin depends on is declared here, narrowly; a use
// outside it is a type error rather than an `any`. Only src/pg.ts references this file.
declare module "pg" {
  import type { EventEmitter } from "node:events";
  import type { Duplex } from "node:stream";
  import type { ConnectionOptions, PeerCertificate } from "node:tls";

  // `object`, not a record type, so an interface describing a row (which has no index signature) fits.
  export type QueryResultRow = object;

  export interface FieldDef {
    name: string;
    dataTypeID: number;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    command: string;
    rowCount: number | null;
    rows: R[];
    fields: FieldDef[];
  }

  export interface ClientConfig {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: false | ConnectionOptions;
    application_name?: string;
    connectionTimeoutMillis?: number;
    query_timeout?: number;
    keepAlive?: boolean;
    enableChannelBinding?: boolean;
  }

  export interface PoolConfig extends ClientConfig {
    max?: number;
    min?: number;
    idleTimeoutMillis?: number;
    maxLifetimeSeconds?: number;
    allowExitOnIdle?: boolean;
    /** pg-pool constructs this class for each connection. */
    Client?: new (
      config: ClientConfig,
    ) => Client;
  }

  export interface Notification {
    processId: number;
    channel: string;
    payload?: string;
  }

  export interface NoticeMessage {
    severity?: string;
    code?: string;
  }

  export class DatabaseError extends Error {
    code?: string;
    severity?: string;
    schema?: string;
    table?: string;
    column?: string;
    constraint?: string;
    routine?: string;
  }

  export interface TlsSocketLike extends Duplex {
    getPeerCertificate(detailed: true): PeerCertificate & { issuerCertificate?: PeerCertificate };
    authorized?: boolean;
  }

  export interface Connection extends EventEmitter {
    stream: TlsSocketLike;
  }

  export class Client extends EventEmitter {
    constructor(config?: ClientConfig);
    readonly processID: number | null;
    connection: Connection;
    connect(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
    getTransactionStatus(): "I" | "T" | "E" | null;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "notice", listener: (notice: NoticeMessage) => void): this;
    on(event: "notification", listener: (message: Notification) => void): this;
    on(event: "end", listener: () => void): this;
    // Overridden by ScramOnlyClient in src/pool.ts; part of pg's client, pinned by a test.
    protected _handleAuthCleartextPassword(message: unknown): void;
    protected _handleAuthMD5Password(message: unknown): void;
  }

  export interface PoolClient extends Client {
    release(destroy?: boolean | Error): void;
  }

  export class Pool extends EventEmitter {
    constructor(config?: PoolConfig);
    readonly totalCount: number;
    readonly idleCount: number;
    readonly waitingCount: number;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "error", listener: (error: Error, client: PoolClient) => void): this;
    on(event: "connect" | "acquire" | "remove", listener: (client: PoolClient) => void): this;
  }

  export function escapeIdentifier(value: string): string;
  export function escapeLiteral(value: string): string;

  const pg: {
    Client: typeof Client;
    Pool: typeof Pool;
    DatabaseError: typeof DatabaseError;
    escapeIdentifier: typeof escapeIdentifier;
    escapeLiteral: typeof escapeLiteral;
  };
  export default pg;
}
