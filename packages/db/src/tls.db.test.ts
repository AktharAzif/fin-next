// TLS against a real Postgres 18 (spec 01 §6.6 step 5, AC-P0-29's local half, DECISIONS P-18): the
// pool's verify-full with the pinned CA and the server name set in code, `--print-db-cert`'s read of the
// presented chain, and the refusal of cleartext password authentication. The shared test server has TLS
// off, so this file starts its own throwaway cluster with a self-signed certificate (Railway's shape).
// It needs the Postgres binaries: set FIN_TEST_PG_BINDIR to the directory holding initdb and pg_ctl
// (CI's service container has none, so CI skips it and the staging check, AC-P0-29, covers it there).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPresentedCertificate } from "./connect.ts";
import { clientConfig, InsecureAuthenticationError, ScramOnlyClient } from "./pool.ts";

const BINDIR = process.env.FIN_TEST_PG_BINDIR ?? "";
const enabled = BINDIR !== "";

let dir = "";
let port = 0;
let password = "";
let serverCert = "";
let otherCert = "";

function openssl(args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
}

function selfSigned(name: string, san: string): string {
  writeFileSync(
    join(dir, `${name}.cnf`),
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      `CN = ${name}`,
      "[ext]",
      `subjectAltName = ${san}`,
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign",
      "",
    ].join("\n"),
  );
  openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", `${name}.key`, "-out", `${name}.crt`, "-config", `${name}.cnf`,
  ]);
  return readFileSync(join(dir, `${name}.crt`), "utf8");
}

beforeAll(async () => {
  if (!enabled) return;
  dir = mkdtempSync(join(tmpdir(), "fin-tls-"));
  password = randomBytes(24).toString("base64url");
  serverCert = selfSigned("server", "DNS:localhost, IP:127.0.0.1");
  otherCert = selfSigned("other", "DNS:localhost");
  execFileSync("chmod", ["600", join(dir, "server.key")]);
  writeFileSync(join(dir, "pw"), password);
  execFileSync(join(BINDIR, "initdb"), [
    "-D", join(dir, "data"), "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${join(dir, "pw")}`, "-E", "UTF8",
  ], { stdio: "ignore" });
  port = 41000 + Math.floor(Math.random() * 8000);
  writeFileSync(
    join(dir, "data", "postgresql.auto.conf"),
    [
      `port = ${port}`,
      "listen_addresses = '127.0.0.1'",
      `unix_socket_directories = '${dir}'`,
      "ssl = on",
      `ssl_cert_file = '${join(dir, "server.crt")}'`,
      `ssl_key_file = '${join(dir, "server.key")}'`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "data", "pg_hba.conf"),
    [
      "local all all scram-sha-256",
      "hostssl all cleartext_user 127.0.0.1/32 password",
      "hostssl all all 127.0.0.1/32 scram-sha-256",
      "",
    ].join("\n"),
  );
  execFileSync(join(BINDIR, "pg_ctl"), ["-D", join(dir, "data"), "-l", join(dir, "log"), "-w", "start"], {
    stdio: "ignore",
  });
}, 120_000);

afterAll(() => {
  if (!enabled || dir === "") return;
  try {
    execFileSync(join(BINDIR, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function client(host: string, caPem: string, servername: string, user = "postgres", pass = password): ScramOnlyClient {
  return new ScramOnlyClient({
    ...clientConfig({
      host,
      port,
      database: "postgres",
      user,
      password: pass,
      tls: { caPem, servername },
      applicationName: "fin-test-tls",
    }),
    connectionTimeoutMillis: 5_000,
  });
}

async function connects(c: ScramOnlyClient): Promise<string> {
  try {
    await c.connect();
    const result = await c.query<{ ssl: boolean }>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
    return result.rows[0]?.ssl === true ? "tls" : "plain";
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  } finally {
    await c.end().catch(() => {});
  }
}

describe.skipIf(!enabled)("TLS to Postgres 18 (P-18)", () => {
  it("prints the chain the server presents, with its SHA-256 fingerprint", async () => {
    const presented = await readPresentedCertificate({ host: "127.0.0.1", port, database: "postgres" });
    expect(presented.chain).toHaveLength(1);
    const body = (pem: string) => pem.replace(/-----[A-Z ]+-----|\s/g, "");
    expect(body(presented.chain[0] ?? "")).toBe(body(serverCert));
    const fingerprint = execFileSync("openssl", ["x509", "-noout", "-fingerprint", "-sha256", "-in", join(dir, "server.crt")])
      .toString()
      .trim()
      .split("=")[1];
    expect(presented.fingerprints[0]).toBe(fingerprint);
  });

  it("connects with verify-full against the pinned certificate and the configured server name", async () => {
    expect(await connects(client("localhost", serverCert, "localhost"))).toBe("tls");
    expect(await connects(client("127.0.0.1", serverCert, "localhost"))).toBe("tls");
  });

  it("refuses a server whose certificate the pinned CA did not sign", async () => {
    expect(await connects(client("localhost", otherCert, "localhost"))).not.toBe("tls");
  });

  it("refuses a server name the certificate does not carry", async () => {
    expect(await connects(client("127.0.0.1", serverCert, "db.example.com"))).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("refuses cleartext password authentication before sending the password", async () => {
    const su = client("localhost", serverCert, "localhost");
    await su.connect();
    const pass = randomBytes(18).toString("base64url");
    try {
      await su.query(`CREATE ROLE cleartext_user LOGIN PASSWORD '${pass}'`);
    } finally {
      await su.end();
    }
    const c = client("localhost", serverCert, "localhost", "cleartext_user", pass);
    await expect(c.connect()).rejects.toBeInstanceOf(InsecureAuthenticationError);
    await c.end().catch(() => {});
  });
});
