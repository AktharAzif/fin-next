// `process.health`'s fields (ARCHITECTURE §10.2, §4.5): the HTTP server's sockets are
// `httpConnections`; `listenConnected` belongs to the Postgres LISTEN client and comes only from
// the database layer; what a process adds never replaces a core field.
import { describe, expect, it } from "vitest";
import { capture } from "../testing/capture.ts";
import { startProcessHealth } from "./process-health.ts";

describe("startProcessHealth", () => {
  it("reports the HTTP sockets as httpConnections, and no listenConnected of its own", async () => {
    const { telemetry } = capture();
    const health = startProcessHealth({ telemetry, httpConnections: async () => 0 });
    try {
      const fields = await health.sample();
      expect(fields).toMatchObject({
        httpConnections: 0,
        heapUsedMb: expect.any(Number),
        rssMb: expect.any(Number),
        background: 0,
      });
      expect(fields).not.toHaveProperty("listenConnected");
    } finally {
      health.stop();
    }
  });

  it("reports null, never zero, when a value cannot be read", async () => {
    const { telemetry } = capture();
    const failing = startProcessHealth({
      telemetry,
      httpConnections: async () => {
        throw new Error("closed");
      },
    });
    const none = startProcessHealth({ telemetry });
    try {
      expect((await failing.sample()).httpConnections).toBeNull();
      expect((await none.sample()).httpConnections).toBeNull();
    } finally {
      failing.stop();
      none.stop();
    }
  });

  it("adds the database layer's fields, which never replace a core one", async () => {
    const { telemetry } = capture();
    const health = startProcessHealth({
      telemetry,
      httpConnections: async () => 3,
      extra: async () => ({ listenConnected: true, poolWaiting: 0, httpConnections: 99 }),
    });
    try {
      expect(await health.sample()).toMatchObject({
        listenConnected: true,
        poolWaiting: 0,
        httpConnections: 3,
      });
    } finally {
      health.stop();
    }
  });
});
