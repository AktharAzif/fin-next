// The slice of `pg` (8.23.1) the integration tests use. `pg` ships no types and `@types/pg` is not in
// the approved dependency set (DECISIONS G-06), so this declares only what the tests call.
declare module "pg" {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
  }
  export interface ClientConfig {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionString?: string;
    max?: number;
    application_name?: string;
  }
  export interface PoolClient {
    query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    release(error?: Error | boolean): void;
  }
  export class Pool {
    constructor(config?: ClientConfig);
    query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
  export interface Notification {
    channel: string;
    payload?: string;
  }
  export class Client {
    constructor(config?: ClientConfig);
    connect(): Promise<void>;
    query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    on(event: "notification", listener: (message: Notification) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "end", listener: () => void): this;
    end(): Promise<void>;
  }
  const pg: { Pool: typeof Pool; Client: typeof Client };
  export default pg;
}
