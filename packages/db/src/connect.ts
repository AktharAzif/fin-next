// Single connections for the migrate service: the superuser's for one run, fin_owner's with a password
// that lives only for that run (spec 01 §6.6 steps 4 and 6; DECISIONS AU-08), and the certificate
// read of step 5.
import { generateDatabasePassword, scramSha256Verifier } from "@fin/crypto";
import type { Clock } from "./context.ts";
import { DatabaseConfigError } from "./errors.ts";
import { escapeLiteral, type PgClient } from "./pg.ts";
import {
  type ConnectionSettings,
  clientConfig,
  ScramOnlyClient,
  type TlsSettings,
} from "./pool.ts";

export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
}

export interface Credentials {
  user: string;
  password: string;
}

/**
 * Reads FIN_BOOTSTRAP_DATABASE_URL, the superuser URL referenced into `migrate` for one run. Only the
 * host, port, database and credentials are taken; a query string (where `sslmode` would go) is refused,
 * because TLS is set in code (P-18). Errors name the variable, never the value.
 */
export function parseSuperuserUrl(text: string | undefined): DatabaseTarget & Credentials {
  const variable = "FIN_BOOTSTRAP_DATABASE_URL";
  if (text === undefined || text === "") throw new DatabaseConfigError(variable, "is required");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DatabaseConfigError(variable, "is not a URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new DatabaseConfigError(variable, "is not a postgres URL");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new DatabaseConfigError(variable, "must carry no parameters: TLS is set in code");
  }
  let database: string;
  let user: string;
  let password: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new DatabaseConfigError(variable, "has a malformed escape");
  }
  const port = url.port === "" ? 5432 : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (database === "" || user === "" || password === "" || host === "") {
    throw new DatabaseConfigError(variable, "needs a host, a database, a user and a password");
  }
  return { host, port, database, user, password };
}

export async function connectClient(settings: ConnectionSettings): Promise<PgClient> {
  const client = new ScramOnlyClient({
    ...clientConfig(settings),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return client;
}

/**
 * Gives fin_owner a fresh password for this run only: a random value made here, handed to Postgres as
 * a SCRAM verifier `VALID UNTIL` the run's end, used for one connection, and cleared when `fn` ends
 * (and by expiry if the clear itself fails). The plaintext never leaves this process.
 */
export async function withOwnerSession<T>(
  superuser: PgClient,
  target: DatabaseTarget & { tls: TlsSettings; applicationName: string },
  clock: Clock,
  fn: (owner: PgClient, settings: ConnectionSettings) => Promise<T>,
  minutes = 60,
): Promise<T> {
  const password = generateDatabasePassword();
  const until = new Date(clock.now().getTime() + minutes * 60_000).toISOString();
  await superuser.query(
    `ALTER ROLE fin_owner WITH LOGIN PASSWORD ${escapeLiteral(scramSha256Verifier(password))} VALID UNTIL ${escapeLiteral(until)}`,
  );
  try {
    const settings: ConnectionSettings = { ...target, user: "fin_owner", password };
    const owner = await connectClient(settings);
    try {
      return await fn(owner, settings);
    } finally {
      await owner.end().catch(() => {});
    }
  } finally {
    await superuser.query("ALTER ROLE fin_owner WITH PASSWORD NULL VALID UNTIL 'infinity'");
  }
}

export interface PresentedCertificate {
  /** PEM of each certificate the server presented, leaf first. */
  chain: string[];
  /** SHA-256 fingerprint of each, colon-separated upper-case hex (as openssl prints it). */
  fingerprints: string[];
}

function toPem(der: Buffer): string {
  const body = der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/**
 * `migrate --print-db-cert` (spec 01 §6.6 step 5): connects once without verification, inside the
 * private network, and returns the chain the server presented. It stops after the TLS handshake and
 * never authenticates, so no password is involved. The operator pins the root as FIN_DB_CA_PEM.
 */
export async function readPresentedCertificate(
  target: DatabaseTarget,
): Promise<PresentedCertificate> {
  const client = new ScramOnlyClient({
    host: target.host,
    port: target.port,
    database: target.database,
    user: "fin_probe",
    password: "",
    // No server name: pg sends the host as SNI itself when it is a name, and Node refuses an IP as one.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  return new Promise<PresentedCertificate>((resolve, reject) => {
    let settled = false;
    const read = () => {
      try {
        const chain: string[] = [];
        const fingerprints: string[] = [];
        let cert = client.connection.stream.getPeerCertificate(true);
        const seen = new Set<string>();
        while (cert?.raw !== undefined && !seen.has(cert.fingerprint256)) {
          seen.add(cert.fingerprint256);
          chain.push(toPem(cert.raw));
          fingerprints.push(cert.fingerprint256);
          const issuer = cert.issuerCertificate;
          if (issuer === undefined || issuer.fingerprint256 === cert.fingerprint256) break;
          cert = issuer;
        }
        settled = true;
        client.connection.stream.destroy();
        if (chain.length === 0) reject(new Error("the server presented no certificate"));
        else resolve({ chain, fingerprints });
      } catch (error) {
        settled = true;
        reject(error);
      }
    };
    // pg emits `sslconnect` as soon as it has wrapped the socket; the peer's certificate is known only
    // once the handshake ends, so the read waits for the TLS socket's own `secureConnect`.
    client.connection.once("sslconnect", () => {
      client.connection.stream.once("secureConnect", read);
    });
    client.connect().catch((error: unknown) => {
      if (!settled) reject(error);
    });
  });
}
