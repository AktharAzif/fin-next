import { describe, expect, it } from "vitest";
import { accessPolicyHash, canonicalJson, rulesetHash, sha256Hex } from "../src/hash.ts";
import { allowedOrigins, emailNames, parseSettings } from "../src/settings.ts";
import { healthyWorld, settingsFor } from "./world.ts";

describe("settings", () => {
  it("accepts the deployed shape", async () => {
    const settings = await settingsFor(healthyWorld());
    expect(settings.scriptName).toBe("fin-next-staging-watcher");
    expect(settings.cron).toBe("* * * * *");
    expect(emailNames(settings).dmarc).toBe("_dmarc.example.net");
    expect([...allowedOrigins(settings, "admin")]).toHaveLength(2);
  });

  it("refuses a hostname outside the zone, a missing egress, or a bad hash", async () => {
    const good = await settingsFor(healthyWorld());
    const cases: [string, unknown][] = [
      ["outside the zone", { ...good, hosts: { ...good.hosts, admin: "admin.example.org" } }],
      ["no static egress", { ...good, egress: {} }],
      ["not a hash", { ...good, rulesetHashes: { x: "nope" } }],
      ["not an account ID", { ...good, accountId: "abc" }],
      [
        "replicas",
        { ...good, tunnels: { ...good.tunnels, public: { ...good.tunnels.public, replicas: 0 } } },
      ],
      ["not valid JSON", "{"],
    ];
    for (const [message, value] of cases) {
      expect(() => parseSettings(value), message).toThrow(new RegExp(message));
    }
  });
});

describe("hashes", () => {
  it("are independent of key order and of rule IDs, versions and timestamps", async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const a = await rulesetHash([{ id: "1", version: "1", expression: "x", action: "block" }]);
    const b = await rulesetHash([{ action: "block", expression: "x", id: "2", version: "7" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(await rulesetHash([{ expression: "y", action: "block" }]));
  });

  it("depend on rule order, which Cloudflare evaluates in", async () => {
    const one = { expression: "a", action: "block" };
    const two = { expression: "b", action: "skip" };
    expect(await rulesetHash([one, two])).not.toBe(await rulesetHash([two, one]));
  });

  it("order Access policies by precedence", async () => {
    const p1 = { name: "a", precedence: 1, decision: "allow", include: [] };
    const p2 = { name: "b", precedence: 2, decision: "deny", include: [] };
    expect(await accessPolicyHash([p1, p2])).toBe(await accessPolicyHash([p2, p1]));
    expect(await accessPolicyHash([p1])).not.toBe(
      await accessPolicyHash([{ ...p1, decision: "deny" }]),
    );
  });

  it("are SHA-256 in hex", async () => {
    expect(await sha256Hex("")).toBe(
      ["e3b0c44298fc1c14", "9afbf4c8996fb924", "27ae41e4649b934c", "a495991b7852b855"].join(""),
    );
  });
});
