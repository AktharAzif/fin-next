// The boot skeletons are the frame as it will draw (spec 06 §2.2, §5.2; FW-S3 measures them): the
// rows that give the page its height come from AppShell's own markup, so the first render does not
// move the page. The console draws the Sandbox strip on every page until go-live; Fin Admin never
// does. Below 1024px both draw the phone header's two rows.
import { AppShell, DeploymentBadge, EnvironmentSwitch } from "@fin/ui/shell";
import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import adminSkeleton from "../boot/admin-skeleton.html?raw";
import appSkeleton from "../boot/app-skeleton.html?raw";

/** The classes that set a box's height or the space around it. */
function geometry(classes: string): string[] {
  return classes
    .split(/\s+/)
    .filter((name) => /^(?:h|min-h|p|px|py|pt|pb|gap)-/.test(name) || name === "border-b")
    .sort();
}

function classOf(html: string, pattern: RegExp): string {
  const found = pattern.exec(html)?.[1];
  expect(found, String(pattern)).toBeDefined();
  return found ?? "";
}

const Link = (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />;

/** AppShell at one forced layout, with marked slots so its rows can be found in the markup. */
function shell(variant: "console" | "admin", layout: "mobile" | "expanded"): string {
  return renderToStaticMarkup(
    <AppShell
      variant={variant}
      nav={{ groups: [], footer: [], currentId: null }}
      brand={{ href: "/", label: "Fin home" }}
      linkAs={Link}
      collapsed={false}
      onCollapsedChange={() => {}}
      strip={variant === "console" ? "sandbox" : null}
      environment={<span data-slot-environment="" />}
      account={<span data-slot-account="" />}
      layout={layout}
    >
      <p>page</p>
    </AppShell>,
  );
}

const skeletons = { console: appSkeleton, admin: adminSkeleton } as const;

describe("the boot skeletons' geometry", () => {
  for (const variant of ["console", "admin"] as const) {
    const skeleton = skeletons[variant];

    it(`${variant}: the phone header's two rows, as AppShell draws them below 1024px`, () => {
      const phone = shell(variant, "mobile");
      const header = classOf(phone, /<header class="([^"]*)"><div class="[^"]*">/);
      const rowOne = classOf(phone, /<header class="[^"]*"><div class="([^"]*)">/);
      const rowTwo = classOf(
        phone,
        /<div class="([^"]*)"><span data-slot-environment=""><\/span><\/div><\/header>/,
      );
      expect(geometry(classOf(skeleton, /data-boot-header="phone" class="([^"]*)"/))).toEqual(
        geometry(header),
      );
      expect(geometry(classOf(skeleton, /data-boot-row="1" class="([^"]*)"/))).toEqual(
        geometry(rowOne),
      );
      expect(geometry(classOf(skeleton, /data-boot-row="2" class="([^"]*)"/))).toEqual(
        geometry(rowTwo),
      );
      expect(classOf(skeleton, /data-boot-header="phone" class="([^"]*)"/)).toContain("lg:hidden");
    });

    it(`${variant}: the one-row header from 1024px`, () => {
      const wide = shell(variant, "expanded");
      const header = classOf(wide, /<header class="([^"]*)"><div class="[^"]*"><span data-slot/);
      const drawn = classOf(skeleton, /data-boot-header="wide" class="([^"]*)"/);
      expect(geometry(drawn)).toEqual(geometry(header));
      expect(drawn.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
    });
  }

  it("console: the Sandbox strip's row above everything, at the strip's height", () => {
    const strip = classOf(shell("console", "expanded"), /data-strip="sandbox" class="([^"]*)"/);
    const drawn = classOf(appSkeleton, /data-boot-strip class="([^"]*)"/);
    expect(geometry(drawn)).toEqual(geometry(strip));
    // First inside the block, before the row that holds the sidebar and the header.
    expect(appSkeleton.indexOf("data-boot-strip")).toBeLessThan(
      appSkeleton.indexOf("data-boot-sidebar"),
    );
  });

  it("Fin Admin: no strip, as AppShell draws none for it", () => {
    expect(shell("admin", "expanded")).not.toContain("data-strip");
    expect(adminSkeleton).not.toContain("data-boot-strip");
  });

  it("the second phone row holds shapes as tall as its controls", () => {
    const environmentSwitch = renderToStaticMarkup(
      <EnvironmentSwitch value="sandbox" onValueChange={() => {}} productionLocked={null} />,
    );
    expect(environmentSwitch).toMatch(/class="[^"]*\bh-8\b/);
    const badge = renderToStaticMarkup(<DeploymentBadge environment="staging" />);
    expect(badge).toMatch(/class="[^"]*\bh-5\b/);
    const rowOf = (html: string) =>
      /data-boot-row="2"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1] ?? "";
    expect(rowOf(appSkeleton).match(/\bh-8\b/g)).toHaveLength(2);
    expect(rowOf(adminSkeleton).match(/\bh-5\b/g)).toHaveLength(1);
  });

  it("never scrolls sideways: the block clips, and the organisation's shape may shrink", () => {
    for (const skeleton of [appSkeleton, adminSkeleton]) {
      expect(classOf(skeleton, /data-boot-block="app"[^>]*class="([^"]*)"/)).toContain(
        "overflow-hidden",
      );
    }
    expect(appSkeleton).toMatch(/data-skeleton class="h-8 w-36 min-w-0 shrink /);
  });
});
