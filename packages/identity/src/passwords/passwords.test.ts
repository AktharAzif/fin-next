// Unit tests for passwords (spec 02 §5.7, [SA-06], [SA-07]; ARCHITECTURE §3.5): the argon2id
// hashes and their load shedding, the rule and the common list, the realm's options and allowlist
// with passwords on, and the staff realm with them never.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePasswordHash } from "@fin/crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { untouchableDatabase } from "../../test/fake-db.ts";
import { DOCS_ORIGIN, testEnv } from "../../test/harness.ts";
import { COMMON_PASSWORD_SOURCES, COMMON_PASSWORDS } from "../common-passwords.ts";
import { DEFAULT_THREAD_POOL_SIZE, parseThreadPoolSize, readRealmSettings } from "../config.ts";
import { createEndpointPolicy } from "../endpoint-policy.ts";
import { AuthRefusal } from "../errors.ts";
import { systemClock } from "../ports/clock.ts";
import { MemoryLineSink } from "../ports/log.ts";
import { createPgDatabase } from "../ports/pg-database.ts";
import { createRealm } from "../realm.ts";
import { CLIENTS_KEPT_FREE, createPasswordHasher, hashSlots, THREADS_KEPT_FREE } from "./hasher.ts";
import {
  assertNewPassword,
  comparable,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
} from "./policy.ts";

/** Work that finishes only when the test says, to hold hashing slots. */
function heldWork() {
  const pending: (() => void)[] = [];
  const hold = () =>
    new Promise<void>((resolve) => {
      pending.push(resolve);
    });
  return {
    pending,
    work: {
      hash: async (password: string) => {
        await hold();
        return `hashed:${password}`;
      },
      verify: async () => {
        await hold();
        return true;
      },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the password hasher", () => {
  it("makes argon2id PHC strings with SA-07's parameters, salted per hash", async () => {
    const hasher = createPasswordHasher({ lines: new MemoryLineSink() });
    const a = await hasher.hash("harbour light forty two");
    const b = await hasher.hash("harbour light forty two");
    expect(a).not.toBe(b);
    const parsed = parsePasswordHash(a);
    expect({
      memoryKiB: parsed.memoryKiB,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.tagLength,
    }).toEqual({ memoryKiB: 19_456, passes: 2, parallelism: 1, tagLength: 32 });
    expect(await hasher.verify({ hash: a, password: "harbour light forty two" })).toBe(true);
    expect(await hasher.verify({ hash: a, password: "harbour light forty three" })).toBe(false);
    // A stored string that is not an argon2id PHC string never verifies.
    expect(await hasher.verify({ hash: "scrypt:abc", password: "x" })).toBe(false);
  });

  it("allows two hashes per vCPU, never libuv's last two threads (ARCHITECTURE §3.5)", () => {
    // UV_THREADPOOL_SIZE=8 on the console; a database pool large enough not to matter here.
    const roomy = { threadPoolSize: 8, databasePoolSize: 100 };
    expect(hashSlots(roomy, 1).concurrency).toBe(2);
    expect(hashSlots(roomy, 2).concurrency).toBe(4);
    for (const cpus of [3, 4, 8, 10, 16, 64, 192]) {
      expect(hashSlots(roomy, cpus).concurrency, `${cpus} vCPUs`).toBe(8 - THREADS_KEPT_FREE);
    }
    // libuv's default pool of 4 (UV_THREADPOOL_SIZE unset) leaves two slots.
    expect(hashSlots({ threadPoolSize: 4, databasePoolSize: 100 }, 64).concurrency).toBe(2);
  });

  it("never lets waiting and hashing requests hold the database pool's last two clients", () => {
    for (const databasePoolSize of [3, 6, 8, 10, 12, 30]) {
      for (const cpus of [1, 2, 4, 10, 64]) {
        const slots = hashSlots({ threadPoolSize: 8, databasePoolSize }, cpus);
        const label = `pool ${databasePoolSize}, ${cpus} vCPUs`;
        expect(slots.concurrency, label).toBeGreaterThanOrEqual(1);
        expect(slots.concurrency, label).toBeLessThanOrEqual(8 - THREADS_KEPT_FREE);
        expect(slots.concurrency + slots.queueLimit, label).toBeLessThanOrEqual(
          Math.max(1, databasePoolSize - CLIENTS_KEPT_FREE),
        );
        expect(slots.queueLimit, label).toBeLessThanOrEqual(4 * slots.concurrency);
      }
    }
    // The console's pool of 10 with UV_THREADPOOL_SIZE=8: six hashes and two waiting at most,
    // so a flood is answered 503 while two clients are still free for every other route.
    expect(hashSlots({ threadPoolSize: 8, databasePoolSize: 10 }, 8)).toEqual({
      concurrency: 6,
      queueLimit: 2,
    });
    // The smallest process still hashes, one at a time.
    expect(hashSlots({ threadPoolSize: 1, databasePoolSize: 1 }, 1)).toEqual({
      concurrency: 1,
      queueLimit: 0,
    });
  });

  it("is sized by libuv's and node-postgres's defaults when not told the process's limits", () => {
    const hasher = createPasswordHasher({ lines: new MemoryLineSink() });
    expect(hasher.slots).toEqual(
      hashSlots({ threadPoolSize: DEFAULT_THREAD_POOL_SIZE, databasePoolSize: 10 }),
    );
    expect(hasher.slots.concurrency).toBeLessThanOrEqual(DEFAULT_THREAD_POOL_SIZE - 2);
    // A slot count given alone keeps its queue within the clients hashing may hold.
    const given = createPasswordHasher({
      lines: new MemoryLineSink(),
      limits: { threadPoolSize: 8, databasePoolSize: 6 },
      concurrency: 3,
    });
    expect(given.slots).toEqual({ concurrency: 3, queueLimit: 1 });
  });

  it("reads UV_THREADPOOL_SIZE as libuv sizes its pool, refusing a value libuv would misread", () => {
    expect(parseThreadPoolSize(undefined)).toBe(4);
    expect(parseThreadPoolSize("8")).toBe(8);
    expect(parseThreadPoolSize(" 16 ")).toBe(16);
    expect(parseThreadPoolSize("1024")).toBe(1024);
    for (const raw of ["", "0", "1025", "-2", "8.5", "eight", "0x8", "1e3"]) {
      expect(() => parseThreadPoolSize(raw), JSON.stringify(raw)).toThrow(/^UV_THREADPOOL_SIZE /);
    }
    const settings = (value?: string) =>
      readRealmSettings(
        "developer",
        testEnv("developer", value === undefined ? {} : { UV_THREADPOOL_SIZE: value }),
      );
    expect(settings().threadPoolSize).toBe(4);
    expect(settings("8").threadPoolSize).toBe(8);
    expect(() => settings("")).toThrow(/^UV_THREADPOOL_SIZE /);
  });

  it("runs at most `concurrency` at once and hands a freed slot to the next waiter", async () => {
    const { pending, work } = heldWork();
    const hasher = createPasswordHasher({
      lines: new MemoryLineSink(),
      concurrency: 2,
      queueLimit: 4,
      queueWaitMs: 60_000,
      work,
    });
    const results = [1, 2, 3].map((n) => hasher.hash(`p${n}`));
    await tick();
    expect(hasher.load()).toEqual({ running: 2, waiting: 1 });
    pending.shift()?.();
    await results[0];
    await tick();
    expect(hasher.load()).toEqual({ running: 2, waiting: 0 });
    while (pending.length > 0) {
      pending.shift()?.();
      await tick();
    }
    expect(await Promise.all(results)).toEqual(["hashed:p1", "hashed:p2", "hashed:p3"]);
    expect(hasher.load()).toEqual({ running: 0, waiting: 0 });
  });

  it("refuses with 503 and Retry-After past a full queue, and writes its line", async () => {
    const { pending, work } = heldWork();
    const lines = new MemoryLineSink();
    const hasher = createPasswordHasher({
      lines,
      concurrency: 1,
      queueLimit: 1,
      queueWaitMs: 60_000,
      retryAfterSeconds: 3,
      work,
    });
    const first = hasher.hash("a");
    const second = hasher.hash("b");
    await expect(hasher.hash("c")).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
      extensions: { retry_after: 3 },
    });
    expect(lines.named("auth.password_hash_busy")).toEqual([{ reason: "queue_full" }]);
    pending.shift()?.();
    await first;
    await tick();
    pending.shift()?.();
    await second;
  });

  it("refuses a request that waited too long for a slot", async () => {
    const { pending, work } = heldWork();
    const lines = new MemoryLineSink();
    const hasher = createPasswordHasher({ lines, concurrency: 1, queueWaitMs: 5, work });
    const first = hasher.hash("a");
    const waited = hasher.hash("b");
    await expect(waited).rejects.toBeInstanceOf(AuthRefusal);
    expect(lines.named("auth.password_hash_busy")).toEqual([{ reason: "queue_wait" }]);
    expect(hasher.load()).toEqual({ running: 1, waiting: 0 });
    pending.shift()?.();
    await first;
    expect(hasher.load()).toEqual({ running: 0, waiting: 0 });
  });
});

describe("the password rule", () => {
  it("is 12 to 128 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(passwordProblem("eleven char")).toBe("too_short");
    expect(passwordProblem("twelve chars")).toBeNull();
    expect(passwordProblem("x".repeat(64) + "y".repeat(64))).toBeNull();
    expect(passwordProblem(`${"x".repeat(64)}${"y".repeat(65)}`)).toBe("too_long");
  });

  it("counts characters, not bytes or UTF-16 units, toward the minimum", () => {
    // Eleven characters, one of them outside the BMP (two UTF-16 units).
    expect(passwordProblem("harbour 🌊 a")).toBe("too_short");
    expect("harbour 🌊 a".length).toBe(12);
    expect(passwordProblem("harbour 🌊 ab")).toBeNull();
  });

  it("refuses the common list in any case, one repeated character, and the address", () => {
    expect(passwordProblem("password1234")).toBe("common");
    expect(passwordProblem("PassWord1234")).toBe("common");
    expect(passwordProblem("qwertyuiop12")).toBe("common");
    expect(passwordProblem("zzzzzzzzzzzzzzzz")).toBe("common");
    expect(passwordProblem("maya.rivera@example.com", { email: "Maya.Rivera@example.com" })).toBe(
      "common",
    );
    expect(passwordProblem("maya.rivera.x", { email: "maya.rivera.x@example.com" })).toBe("common");
    expect(
      passwordProblem("maya.rivera.x is me", { email: "maya.rivera.x@example.com" }),
    ).toBeNull();
  });

  it("uses a password exactly as typed: spaces count and nothing is trimmed", () => {
    expect(passwordProblem("  short  ")).toBe("too_short");
    expect(passwordProblem("   twelve   ")).toBeNull();
  });

  it("sees a common password through spaces, full-width forms and invisible characters", () => {
    const fullWidth = "ｐａｓｓｗｏｒｄ１２３４";
    for (const variant of [
      "password1234 ",
      " password1234",
      "\tpassword1234\n",
      "pass word 1234",
      "password1234 ",
      fullWidth,
      "pass​word1234",
      "pass‍word‌1234",
      "﻿password1234­",
      "PASSWORD⁠1234",
    ]) {
      expect(passwordProblem(variant), JSON.stringify(variant)).toBe("common");
    }
    // One character repeated, or nothing but white space, however it is spaced.
    expect(passwordProblem("a a a a a a a a")).toBe("common");
    expect(passwordProblem(" ".repeat(12))).toBe("common");
    expect(passwordProblem("​".repeat(12))).toBe("common");
    // The address and its local part, with a space or a full-width letter.
    const email = { email: "maya.rivera.x@example.com" };
    expect(passwordProblem(" maya.rivera.x ", email)).toBe("common");
    expect(passwordProblem("ｍaya.rivera.x", email)).toBe("common");
    // The folding is for the comparison only: a passphrase of uncommon words is fine.
    expect(passwordProblem("harbour light forty two")).toBeNull();
    expect(comparable("Harbour Light​ forty two")).toBe("harbourlightfortytwo");
  });

  it("refuses with 400 invalid, naming the field and the problem, never the value", () => {
    const refuse = (password: unknown) => {
      try {
        assertNewPassword(password, "newPassword", { email: "a@example.com" });
        return null;
      } catch (error) {
        return error as AuthRefusal;
      }
    };
    expect(refuse("short")).toMatchObject({
      code: "invalid",
      status: 400,
      extensions: { fields: ["newPassword"], problem: "password_too_short" },
    });
    expect(refuse("password1234")?.extensions).toEqual({
      fields: ["newPassword"],
      problem: "password_common",
    });
    expect(refuse(42)?.extensions).toEqual({
      fields: ["newPassword"],
      problem: "password_missing",
    });
    expect(JSON.stringify(refuse("password1234"))).not.toContain("password1234");
    expect(refuse("a quiet lighthouse at dusk")).toBeNull();
  });
});

describe("the common-password list", () => {
  it("is generated from its named public sources and holds what the rule could refuse", () => {
    expect(COMMON_PASSWORD_SOURCES).toHaveLength(2);
    for (const source of COMMON_PASSWORD_SOURCES) {
      expect(source).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/danielmiessler\/SecLists\/[0-9a-f]{40}\//,
      );
    }
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(1_000);
    const sorted = [...COMMON_PASSWORDS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(COMMON_PASSWORDS).toEqual(sorted);
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
    for (const entry of COMMON_PASSWORDS) {
      expect(entry).toMatch(/^[\x21-\x7e]{12,128}$/);
      expect(entry).toBe(entry.toLowerCase());
    }
  });

  it("says in its header that it is generated, and by what", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "common-passwords.ts"), "utf8");
    expect(text.startsWith("// GENERATED by packages/identity/scripts/common-passwords.mjs")).toBe(
      true,
    );
    expect(text).toContain("sha256 ");
  });
});

describe("the realm with passwords on", () => {
  function build(realm: "developer" | "staff", env: Record<string, string> = {}) {
    const { db, lines } = untouchableDatabase();
    const settings = readRealmSettings(realm, testEnv(realm, env));
    return createRealm({ settings, db, clock: systemClock, lines, docsOrigin: DOCS_ORIGIN });
  }

  it("gives the library Fin's argon2id and §3.3's options (developer realm)", async () => {
    const realm = build("developer", { FIN_FEATURE_PASSWORDS: "on" });
    const ctx = (await realm.auth.$context) as unknown as {
      options: { emailAndPassword: Record<string, unknown> };
      password: { config: { minPasswordLength: number; maxPasswordLength: number } };
    };
    expect(ctx.options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
    });
    expect(ctx.password.config).toMatchObject({ minPasswordLength: 12, maxPasswordLength: 128 });
  });

  it("sizes its hasher by the thread pool and the database pool it runs with (§3.5)", async () => {
    // A pool that is never used: node-postgres connects only on the first query.
    const pool = new pg.Pool({ max: 6 });
    try {
      const lines = new MemoryLineSink();
      const db = createPgDatabase({ pool, clock: systemClock, release: "test", lines });
      expect(db.poolSize).toBe(6);
      const settings = readRealmSettings(
        "developer",
        testEnv("developer", { FIN_FEATURE_PASSWORDS: "on", UV_THREADPOOL_SIZE: "8" }),
      );
      const realm = createRealm({
        settings,
        db,
        clock: systemClock,
        lines,
        docsOrigin: DOCS_ORIGIN,
      });
      const slots = realm.runtime.passwords.slots;
      expect(slots).toEqual(hashSlots({ threadPoolSize: 8, databasePoolSize: 6 }));
      expect(slots.concurrency).toBeLessThanOrEqual(8 - THREADS_KEPT_FREE);
      expect(slots.concurrency + slots.queueLimit).toBeLessThanOrEqual(6 - CLIENTS_KEPT_FREE);
    } finally {
      await pool.end();
    }
    // A pool that does not say its size is taken at node-postgres's default.
    expect(untouchableDatabase().db.poolSize).toBe(10);
  });

  it("keeps passwords off by default, and blocks their paths", async () => {
    const realm = build("developer");
    const ctx = (await realm.auth.$context) as unknown as {
      options: { emailAndPassword: Record<string, unknown> };
    };
    expect(ctx.options.emailAndPassword).toEqual({ enabled: false });
    for (const path of [
      "/sign-in/email",
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/change-password",
    ]) {
      expect(realm.policy.match(path, "POST")?.class, path).toBe("blocked");
    }
  });

  it("lists each password path with its class, reach and limit (§4.2)", () => {
    const policy = createEndpointPolicy("developer", { passwords: true, google: false });
    const view = (path: string) => {
      const rule = policy.match(path, "POST");
      return rule === null ? null : { class: rule.class, reach: rule.reach, limit: rule.limit };
    };
    const any = ["signed_out", "factor_step", "hold", "ok", "pending"];
    expect(view("/sign-in/email")).toEqual({
      class: "public",
      reach: any,
      limit: "password_sign_in",
    });
    expect(view("/email-otp/request-password-reset")).toEqual({
      class: "public",
      reach: any,
      limit: "code_send",
    });
    expect(view("/email-otp/reset-password")).toEqual({
      class: "public",
      reach: any,
      limit: "code_sign_in",
    });
    expect(view("/change-password")).toEqual({
      class: "step_up_self",
      reach: ["ok"],
      limit: "method_add",
    });
    // The link-based flows stay blocked whatever the setting (§4.2).
    for (const path of [
      "/request-password-reset",
      "/reset-password",
      "/forget-password/email-otp",
    ]) {
      expect(policy.match(path, "POST")?.class, path).toBe("blocked");
    }
  });

  it("never has passwords in the staff realm", () => {
    const policy = createEndpointPolicy("staff", { passwords: true, google: false });
    for (const path of [
      "/sign-in/email",
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/change-password",
    ]) {
      expect(policy.match(path, "POST")?.class, path).toBe("blocked");
    }
  });
});
