import { describe, expect, it, vi } from "vitest";
import { captureSelfieTicket, takeSelfieTicket } from "./ticket.ts";

// A ticket-shaped value, built at run time (the public-safety scan never sees a literal one): an
// `sft_` ID with 26 Crockford base32 characters, a dot, and a 32-byte base64url secret.
const ID = ["sft", ["0123456789ABCDEFGHJKMNPQ", "RS"].join("")].join("_");
const SECRET = ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNO-_"].join("");
const TICKET = `${ID}.${SECRET}`;

function run(pathname: string, hash: string) {
  const replaceState = vi.fn();
  const ticket = captureSelfieTicket({ pathname, hash }, { replaceState });
  return { ticket, replaceState };
}

describe("the selfie ticket in the fragment (FW-C20, SD3-03)", () => {
  it("has the shape the test builds", () => {
    expect(ID).toHaveLength(30);
    expect(SECRET).toHaveLength(43);
  });

  it("takes the ticket and clears it from the address bar and the history", () => {
    const { ticket, replaceState } = run("/s", `#${TICKET}`);
    expect(ticket).toBe(TICKET);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/s");
  });

  it("accepts /s with a trailing slash", () => {
    expect(run("/s/", `#${TICKET}`).ticket).toBe(TICKET);
  });

  it("clears any fragment but keeps nothing that is not a ticket on /s", () => {
    for (const [path, hash] of [
      ["/s", "#short"],
      ["/s", `#${ID}`],
      ["/s", `#${TICKET}=`],
      ["/s", `#${ID}.${SECRET.slice(1)}`],
      ["/s", `#lks_${ID.slice(4)}.${SECRET}`],
      ["/s", `#${ID.slice(0, -1)}I.${SECRET}`],
      ["/c", `#${TICKET}`],
    ] as const) {
      const { ticket, replaceState } = run(path, hash);
      expect(ticket, hash).toBeNull();
      expect(replaceState).toHaveBeenCalledWith(null, "", path);
    }
  });

  it("leaves a page with no fragment alone", () => {
    const { ticket, replaceState } = run("/s", "");
    expect(ticket).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("hands the captured ticket over once", () => {
    // No window in unit tests, so nothing was captured as the module loaded.
    expect(takeSelfieTicket()).toBeNull();
  });
});
