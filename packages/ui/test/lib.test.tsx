// lib/: cn, failure reporting, announce on the server.
import { describe, expect, it, vi } from "vitest";
import { announce, cn } from "../src/index.ts";
import { classKey } from "../src/lib/cn.ts";
import { runReported } from "../src/lib/failures.tsx";

describe("cn", () => {
  it("joins strings, arrays and objects, dropping falsy values", () => {
    expect(cn("a", ["b", false, null], { c: true, d: false }, undefined, 0)).toBe("a b c");
  });

  it("lets a later class win over one that sets the same thing", () => {
    expect(cn("h-control-md px-4", "h-control-sm")).toBe("px-4 h-control-sm");
    expect(cn("bg-action-primary text-on-action-primary", "bg-danger-solid")).toBe(
      "text-on-action-primary bg-danger-solid",
    );
    expect(cn("rounded-control", "rounded-full")).toBe("rounded-full");
    expect(cn("shadow-button", "shadow-none")).toBe("shadow-none");
  });

  it("keeps type roles and text colours apart", () => {
    expect(cn("text-label text-text-primary", "text-caption")).toBe(
      "text-text-primary text-caption",
    );
    expect(cn("text-body text-text-primary", "text-text-secondary")).toBe(
      "text-body text-text-secondary",
    );
    expect(cn("text-left", "text-right text-body")).toBe("text-right text-body");
  });

  it("keeps axes apart and resolves each one", () => {
    expect(cn("inset-x-4 inset-y-0", "inset-y-2")).toBe("inset-x-4 inset-y-2");
    expect(cn("px-4 py-2", "px-0")).toBe("py-2 px-0");
    expect(cn("gap-x-2 gap-2")).toBe("gap-x-2 gap-2");
    expect(cn("overflow-x-auto overflow-hidden")).toBe("overflow-x-auto overflow-hidden");
    expect(cn("min-w-48 w-72 max-w-full")).toBe("min-w-48 w-72 max-w-full");
  });

  it("resolves per variant", () => {
    expect(cn("hover:bg-fill-hover", "bg-surface", "hover:bg-fill-selected")).toBe(
      "bg-surface hover:bg-fill-selected",
    );
    expect(cn("sm:hidden", "hidden", "sm:block")).toBe("hidden sm:block");
  });

  it("knows display, position, borders and fonts", () => {
    expect(classKey("inline-flex")).toBe("display");
    expect(classKey("sticky")).toBe("position");
    expect(cn("border border-border", "border-border-strong")).toBe("border border-border-strong");
    expect(cn("border-t border-b")).toBe("border-t border-b");
    expect(cn("font-mono font-medium", "font-regular")).toBe("font-mono font-regular");
  });
});

describe("runReported", () => {
  it("reports a thrown error with the IDs, says so, and passes the failure on", () => {
    const report = vi.fn();
    const failed = vi.fn();
    expect(() =>
      runReported(
        () => {
          throw new Error("x");
        },
        report,
        { request: "req_1" },
        failed,
      ),
    ).toThrow("x");
    expect(report).toHaveBeenCalledWith(expect.any(Error), { request: "req_1" });
    expect(failed).toHaveBeenCalledOnce();
  });

  it("reports a rejection, and returns a promise that still rejects", async () => {
    const report = vi.fn();
    const failed = vi.fn();
    const result = runReported(() => Promise.reject(new Error("y")), report, {}, failed);
    await expect(result).rejects.toThrow("y");
    expect(report).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
  });

  it("does nothing more for an action that succeeds", async () => {
    const report = vi.fn();
    expect(
      runReported(
        () => 3,
        report,
        {},
        () => {},
      ),
    ).toBe(3);
    await expect(
      runReported(
        () => Promise.resolve(4),
        report,
        {},
        () => {},
      ),
    ).resolves.toBe(4);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("announce", () => {
  it("is a no-op without a document", () => {
    expect(() => announce("Loading members")).not.toThrow();
  });
});
