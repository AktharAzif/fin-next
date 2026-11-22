// api's skeleton booted on a real socket: private health, and every other request refused as an
// outside request (403, api.outside_request), signed or not, until the door matrix lists it.
import { bootApi, NEIGHBOUR_ADDRESS } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiService, main } from "../main.ts";

let api: Awaited<ReturnType<typeof bootApi>>;

beforeAll(async () => {
  api = await bootApi(apiService, { service: "api", roles: [], env: {} });
});

afterAll(async () => {
  await api.stop();
  expect(api.exits).toEqual([0]);
});

describe("api", () => {
  it("answers /healthz and /readyz on the private network", async () => {
    expect(
      (
        await api.send({
          host: "api.railway.internal:8080",
          path: "/healthz",
          from: NEIGHBOUR_ADDRESS,
          proof: null,
        })
      ).json(),
    ).toEqual({ status: "ok" });
    expect(
      (await api.send({ host: "healthcheck.railway.app", path: "/readyz", proof: null })).status,
    ).toBe(200);
  });

  it("refuses every unsigned call with 403 and api.outside_request", async () => {
    for (const [method, path] of [
      ["GET", "/internal/v4/customers"],
      ["POST", "/doors/key-revoke"],
      ["GET", "/"],
      ["GET", "/health"],
    ] as const) {
      const res = await api.send({
        host: "api.railway.internal:8080",
        path,
        method,
        proof: null,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(res.status, path).toBe(403);
      expect(res.json()).toMatchObject({ code: "forbidden" });
    }
    const lines = api.stdout.filter((l) => l.event === "api.outside_request");
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.reason === "unsigned" && l.level === "warn")).toBe(true);
  });

  it("refuses a signed call the matrix does not list, and never trusts Cloudflare's headers", async () => {
    const res = await api.send({
      host: "api.railway.internal:8080",
      path: "/internal/v4/customers",
      proof: null,
      headers: {
        "fin-caller-signature": "v2 t=1 n=x k=edge:1 s=x",
        "cf-connecting-ip": "198.51.100.1",
      },
    });
    expect(res.status).toBe(403);
    expect(api.stdout.filter((l) => l.event === "api.outside_request").at(-1)).toMatchObject({
      reason: "not_in_matrix",
    });
  });

  it("exits 64 for a mode whose entry is not wired yet, naming only the mode", async () => {
    for (const [argv, mode] of [
      [["--worker"], "worker"],
      [["--migrate"], "migrate"],
      [["--task", "staff-bootstrap"], "task"],
      [["--anything"], "unknown"],
    ] as const) {
      const exits: number[] = [];
      const lines: string[] = [];
      await main(argv, { exit: (code) => exits.push(code), stdout: (line) => lines.push(line) });
      expect(exits).toEqual([64]);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        event: "process.mode_unavailable",
        mode,
      });
    }
  });
});
