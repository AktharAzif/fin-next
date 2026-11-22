// `auth.library_log` as Better Stack receives it (spec 02 §18.1): the library's own warning, from
// the logger the realm gives it, keeps its level through the process telemetry. The level is
// `libraryLevel`, because a field named `level` shares the envelope's name and is dropped; the
// library's message and arguments are never written.
import { describe, expect, it } from "vitest";
import { untouchableDatabase } from "../test/fake-db.ts";
import { DOCS_ORIGIN, testEnv } from "../test/harness.ts";
import { shippedSink } from "../test/telemetry.ts";
import { type RealmName, readRealmSettings } from "./config.ts";
import { systemClock } from "./ports/clock.ts";
import { createRealm } from "./realm.ts";

interface LibraryLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

describe("auth.library_log through the process telemetry", () => {
  it.each<RealmName>(["developer", "staff"])(
    "ships the %s realm's library warnings and errors with libraryLevel",
    async (realmName) => {
      const sink = shippedSink();
      const { db, pool } = untouchableDatabase();
      const realm = createRealm({
        settings: readRealmSettings(realmName, testEnv(realmName)),
        db,
        clock: systemClock,
        lines: sink.lines,
        docsOrigin: DOCS_ORIGIN,
      });
      const { logger } = (await realm.auth.$context) as unknown as { logger: LibraryLogger };

      await sink.unit(async () => {
        logger.warn("a warning naming person@example.com", { detail: "an argument" });
        logger.error("an error naming person@example.com");
      });

      const lines = (await sink.shipped()).filter((line) => line.event === "auth.library_log");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        event: "auth.library_log",
        level: "warn",
        requestId: sink.requestId,
        realm: realmName,
        libraryLevel: "warn",
      });
      expect(lines[1]).toMatchObject({
        event: "auth.library_log",
        level: "error",
        realm: realmName,
        libraryLevel: "error",
      });
      // Only the envelope, the realm and the level: nothing the library said reaches the line.
      for (const line of lines) {
        expect(Object.keys(line).sort()).toEqual(
          [
            "dt",
            "environment",
            "event",
            "level",
            "libraryLevel",
            "message",
            "realm",
            "release",
            "replica",
            "requestId",
            "service",
          ].sort(),
        );
      }
      expect(pool.connects).toBe(0);
    },
  );
});
