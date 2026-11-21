import { describe, expect, it } from "vitest";
import { defineContract, isUnsafeMethod, noContent, noInput, pathParams } from "./contract.ts";
import * as contracts from "./index.ts";
import { z } from "./zod.ts";

describe("defineContract", () => {
  it("accepts a well-formed contract and returns it unchanged", () => {
    const contract = defineContract({
      name: "team.removeMember",
      method: "POST",
      path: "/team/members/:memberId/remove",
      input: z.object({ memberId: z.string(), rollCredentials: z.boolean() }),
      output: noContent,
      organization: true,
    });
    expect(contract.path).toBe("/team/members/:memberId/remove");
    expect(pathParams(contract.path)).toEqual(["memberId"]);
  });

  it("refuses a path that repeats /api", () => {
    expect(() =>
      defineContract({
        name: "viewer.get",
        method: "GET",
        path: "/api/viewer",
        input: noInput,
        output: z.unknown(),
      }),
    ).toThrow(/must not repeat it/);
  });

  it("refuses a query string, a fragment or an empty segment in the path", () => {
    for (const path of ["/viewer?x=1", "/viewer#a", "/a//b"] as const) {
      expect(() =>
        defineContract({ name: "a.b", method: "GET", path, input: noInput, output: z.unknown() }),
      ).toThrow(/no query/);
    }
  });

  it("refuses a :param the input does not carry", () => {
    expect(() =>
      defineContract({
        name: "team.member",
        method: "GET",
        path: "/team/members/:memberId",
        input: z.object({ id: z.string() }),
        output: z.unknown(),
      }),
    ).toThrow(/no field for :memberId/);
  });

  it("refuses a GET that creates and a bad name or timeout", () => {
    expect(() =>
      defineContract({
        name: "a.b",
        method: "GET",
        path: "/a",
        input: noInput,
        output: z.unknown(),
        creates: true,
      }),
    ).toThrow(/never creates/);
    expect(() =>
      defineContract({
        name: "Bad",
        method: "GET",
        path: "/a",
        input: noInput,
        output: z.unknown(),
      }),
    ).toThrow(/lower camel case/);
    expect(() =>
      defineContract({
        name: "a.b",
        method: "GET",
        path: "/a",
        input: noInput,
        output: z.unknown(),
        timeoutMs: 0,
      }),
    ).toThrow(/positive/);
  });

  it("knows which methods the origin gate checks", () => {
    expect(isUnsafeMethod("GET")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(isUnsafeMethod(method)).toBe(true);
    }
  });
});

describe("the exported contracts", () => {
  const exported: unknown[] = Object.values(contracts);
  const all = exported.filter(
    (value): value is contracts.AppContract =>
      typeof value === "object" && value !== null && "method" in value && "path" in value,
  );

  it("never name a path under /api twice, and each is unique per app", () => {
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const contract of all) expect(contract.path.startsWith("/api")).toBe(false);
    const names = all.map((contract) => contract.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
