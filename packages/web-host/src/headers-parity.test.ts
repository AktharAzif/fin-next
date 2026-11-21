// The API halves' headers and the static profiles must agree where ARCHITECTURE §7.12 says they are
// the same: the permissions and referrer policies per host, and HSTS per zone class. The two live
// apart because src/static/ may import nothing but Node built-ins.
import {
  hstsFor,
  PERMISSIONS_APP,
  PERMISSIONS_DENY_ALL,
  permissionsPolicyFor,
  referrerPolicyFor,
} from "@fin/server/http";
import { describe, expect, it } from "vitest";
import * as profiles from "./static/profiles.ts";
import { hstsValue } from "./static/render.ts";

describe("API headers and static profiles", () => {
  it("share the permissions policies", () => {
    expect(PERMISSIONS_APP).toBe(profiles.PERMISSIONS_APP);
    expect(PERMISSIONS_DENY_ALL).toBe(profiles.PERMISSIONS_DENY_ALL);
  });

  it("give each host the same referrer and permissions policy on its pages and its API", () => {
    for (const output of ["console", "admin", "verify", "selfie", "docs"] as const) {
      const profile = profiles.PROFILES[profiles.OUTPUT_PROFILE[output]];
      expect(referrerPolicyFor(output)).toBe(profile.referrerPolicy);
      expect(permissionsPolicyFor(output)).toBe(profile.permissionsPolicy);
      for (const environment of ["staging", "production"] as const) {
        expect(hstsFor(environment, output)).toBe(hstsValue(environment, output));
      }
    }
  });
});
