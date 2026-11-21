// Static-markup tests for the shell (spec 06 §10.1: Vitest with renderToStaticMarkup, no DOM
// package). Behaviour in a browser (the toggle's press, the menus, the sheet) is the apps' Playwright
// shell specs'.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountMenu, nameFromEmail, StaffMenu } from "../../src/shell/AccountMenu.tsx";
import { AppShell, AppShellContent } from "../../src/shell/AppShell.tsx";
import { DeploymentBadge, deploymentLabel } from "../../src/shell/DeploymentBadge.tsx";
import { EdgeToggle } from "../../src/shell/EdgeToggle.tsx";
import { EnvironmentSwitch } from "../../src/shell/EnvironmentSwitch.tsx";
import { OrganisationSwitcher } from "../../src/shell/OrganisationSwitcher.tsx";
import { PlainLink, Sidebar, type SidebarNav } from "../../src/shell/Sidebar.tsx";

const nav: SidebarNav = {
  currentId: "home",
  groups: [
    {
      id: "home",
      items: [{ id: "home", label: "Home", href: "/", glyph: "House", external: false }],
    },
    {
      id: "money",
      label: "Money movement",
      items: [
        {
          id: "customers",
          label: "Customers",
          href: "/customers",
          glyph: "Users",
          external: false,
        },
      ],
    },
  ],
  footer: [
    {
      id: "settings",
      label: "Settings",
      href: "/settings/organisation",
      glyph: "GearSix",
      external: false,
    },
    {
      id: "api-docs",
      label: "API docs",
      href: "https://docs.example.com/",
      glyph: "BookOpen",
      external: true,
    },
  ],
};
const brand = { href: "/", label: "Fin home" };

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("Sidebar", () => {
  it("draws the expanded sidebar: the brand link, the groups, the current item and the footer", () => {
    const html = renderToStaticMarkup(
      <Sidebar nav={nav} brand={brand} mode="expanded" linkAs={PlainLink} navElementId="nav" />,
    );
    expect(html).toContain('aria-label="Fin home"');
    expect(html).toContain('data-sidebar-mode="expanded"');
    expect(html).toContain("w-sidebar");
    expect(html).toContain('<nav id="nav" aria-label="Main"');
    expect(html).toContain("Money movement");
    expect(count(html, 'aria-current="page"')).toBe(1);
    expect(html).toMatch(/aria-current="page"[^>]*data-nav-item="home"/);
    // The current item's icon is the duo glyph showing its fill weight.
    expect(html).toContain('data-weight="fill"');
    expect(html).toContain("fin-ico--duo");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("(opens in a new tab)");
  });

  it("draws the rail with icons named by tooltips and the 24px mark", () => {
    const html = renderToStaticMarkup(
      <Sidebar nav={nav} brand={brand} mode="rail" linkAs={PlainLink} navElementId="nav" />,
    );
    expect(html).toContain("w-sidebar-collapsed");
    expect(html).toMatch(/<svg[^>]*height="24"/);
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(">Customers<");
    expect(html).toContain('class="m-0 sr-only"');
  });

  it("puts the toggle right after the brand link, before the navigation", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        nav={nav}
        brand={brand}
        mode="expanded"
        linkAs={PlainLink}
        navElementId="nav"
        toggle={<span data-toggle="" />}
      />,
    );
    const brandAt = html.indexOf('aria-label="Fin home"');
    const toggleAt = html.indexOf("data-toggle");
    const navAt = html.indexOf('<nav id="nav"');
    expect(brandAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeGreaterThan(brandAt);
    expect(navAt).toBeGreaterThan(toggleAt);
  });

  it("captions Fin Admin’s lockup", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        nav={{ ...nav, footer: [] }}
        brand={{ href: "/", label: "Fin Admin", caption: "Fin Admin" }}
        mode="expanded"
        linkAs={PlainLink}
        navElementId="nav"
      />,
    );
    expect(html).toContain('aria-label="Fin Admin"');
    expect(html).toContain(">Fin Admin</span>");
  });
});

describe("EdgeToggle", () => {
  it("collapses from the 224px sidebar’s border, 40px down in the console", () => {
    const html = renderToStaticMarkup(
      <EdgeToggle collapsed={false} onToggle={() => {}} controls="nav" offset="console" />,
    );
    expect(html).toContain('data-edge-toggle="collapse"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="nav"');
    expect(html).toContain(">Collapse sidebar<");
    expect(html).toContain("fin-ico--CaretLeft");
    for (const token of [
      "top-10",
      "left-sidebar",
      "-translate-x-1/2",
      "hidden",
      "xl:inline-flex",
      "z-header",
      "size-target-min",
      "rounded-full",
      "shadow-button",
    ]) {
      expect(html).toContain(token);
    }
  });

  it("expands from the rail’s border, 16px down in Fin Admin", () => {
    const html = renderToStaticMarkup(
      <EdgeToggle collapsed onToggle={() => {}} controls="nav" offset="admin" />,
    );
    expect(html).toContain('data-edge-toggle="expand"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Expand sidebar<");
    expect(html).toContain("fin-ico--CaretRight");
    expect(html).toContain("top-4");
    expect(html).toContain("left-sidebar-collapsed");
  });
});

describe("AppShell", () => {
  const shell = (props: Partial<Parameters<typeof AppShell>[0]> = {}) =>
    renderToStaticMarkup(
      <AppShell
        variant="console"
        nav={nav}
        brand={brand}
        linkAs={PlainLink}
        collapsed={false}
        onCollapsedChange={() => {}}
        strip="sandbox"
        environment={<span data-env-slot="" />}
        account={<span data-account-slot="" />}
        {...props}
      >
        <AppShellContent>
          <p>Page</p>
        </AppShellContent>
      </AppShell>,
    );

  it("orders the strip, the sidebar, the header and <main>", () => {
    const html = shell();
    const order = [
      'data-strip="sandbox"',
      'aria-label="Fin home"',
      "data-edge-toggle",
      '<nav id="',
      "data-env-slot",
      "data-account-slot",
      '<main id="main"',
    ].map((needle) => html.indexOf(needle));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("data-app-shell-main");
    expect(html).toContain(">Sandbox<");
  });

  it("draws no strip in Production", () => {
    expect(shell({ strip: null })).not.toContain("data-strip");
  });

  it("forces the rail, and keeps the toggle on it", () => {
    const html = shell({ layout: "collapsed" });
    expect(html).toContain('data-layout="rail"');
    expect(html).toContain('data-edge-toggle="expand"');
  });

  it("draws the phone shell with the menu button and no toggle", () => {
    const html = shell({ layout: "mobile" });
    expect(html).toContain('data-layout="mobile"');
    expect(html).toContain("data-phone-nav-trigger");
    expect(html).toContain(">Open navigation<");
    expect(html).not.toContain("data-edge-toggle");
  });

  it("follows the person’s choice from 1280px", () => {
    expect(shell({ collapsed: true })).toContain('data-layout="rail"');
    expect(shell({ collapsed: false })).toContain('data-layout="expanded"');
  });

  it("draws an empty notice slot as nothing", () => {
    // A notice whose content decides, when it renders, that there is nothing to say.
    const Nothing = () => null;
    const html = renderToStaticMarkup(
      <AppShellContent notice={<Nothing />}>
        <p>Page</p>
      </AppShellContent>,
    );
    expect(html).toContain("empty:hidden");
  });
});

describe("EnvironmentSwitch", () => {
  it("locks Production with the lock glyph first and the sentence as its tooltip", () => {
    const html = renderToStaticMarkup(
      <EnvironmentSwitch
        value="sandbox"
        onValueChange={() => {}}
        productionLocked="Production unlocks when Fin approves your organisation."
      />,
    );
    expect(html).toContain('aria-label="Environment"');
    const production = html.slice(html.indexOf('data-env="production"'));
    expect(production).toMatch(/^data-env="production"[^>]*>/);
    expect(html).toMatch(
      /aria-disabled="true"[^>]*tabindex="0"|tabindex="0"[^>]*aria-disabled="true"/,
    );
    expect(production.indexOf("<svg")).toBeLessThan(production.indexOf("Production<"));
    expect(production).toContain("fin-ico--LockSimple");
    expect(html).toContain("Production unlocks when Fin approves your organisation.");
  });

  it("offers Production as a radio once it is unlocked", () => {
    const html = renderToStaticMarkup(
      <EnvironmentSwitch value="production" onValueChange={() => {}} productionLocked={null} />,
    );
    expect(html).not.toContain("fin-ico--LockSimple");
    expect(count(html, 'role="radio"')).toBe(2);
  });
});

describe("menus", () => {
  it("names the account trigger and shows initials", () => {
    const html = renderToStaticMarkup(
      <AccountMenu
        name="Maya Rivera"
        email="maya@example.com"
        roleLabel="Super admin"
        theme="system"
        onThemeChange={() => {}}
        securityHref="/account/security"
        linkAs={PlainLink}
        onLogOut={async () => {}}
      />,
    );
    expect(html).toContain('aria-label="Account menu, Maya Rivera"');
    expect(html).toContain(">MR<");
    // The menu's own props reach the button: without them a press would never open it.
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-label="Account menu/);
  });

  it("names the trigger by email when there is no name, with the first letter", () => {
    const html = renderToStaticMarkup(
      <AccountMenu
        name=""
        email="maya@example.com"
        roleLabel={null}
        theme="system"
        onThemeChange={() => {}}
        securityHref="/account/security"
        linkAs={PlainLink}
        onLogOut={async () => {}}
      />,
    );
    expect(html).toContain('aria-label="Account menu, maya@example.com"');
    expect(html).toContain(">M<");
  });

  it("draws staff initials from the email’s local part", () => {
    expect(nameFromEmail("nadia.brooks@example.org")).toBe("nadia brooks");
    expect(nameFromEmail("ines@example.org")).toBe("ines");
    const html = renderToStaticMarkup(
      <StaffMenu
        email="nadia.brooks@example.org"
        roleLabel="Admin"
        signIn="access"
        accountHref="/account"
        linkAs={PlainLink}
        onLogOut={async () => {}}
      />,
    );
    expect(html).toContain('aria-label="Account menu, nadia.brooks@example.org"');
    expect(html).toContain(">NB<");
  });

  it("names the organisation switcher with the current organisation", () => {
    const html = renderToStaticMarkup(
      <OrganisationSwitcher
        organisations={[{ id: "org_1", name: "Acme Remit", roleLabel: "Super admin" }]}
        currentId="org_1"
        onSwitch={async () => {}}
        linkAs={PlainLink}
        createHref="/settings/organisation?view=create"
        settingsHref="/settings/organisation"
      />,
    );
    expect(html).toContain('aria-label="Switch organisation, current: Acme Remit"');
    expect(html).toContain("fin-ico--CaretUpDown");
    const none = renderToStaticMarkup(
      <OrganisationSwitcher
        organisations={[]}
        currentId={null}
        onSwitch={async () => {}}
        linkAs={PlainLink}
        createHref="/x"
        settingsHref="/y"
      />,
    );
    expect(none).toContain("current: No organisation");
  });
});

describe("Fin Admin’s header", () => {
  it("names the deployment, and Unknown for anything else", () => {
    expect(deploymentLabel("staging")).toBe("Staging");
    expect(deploymentLabel("constructor")).toBe("Unknown");
    const html = renderToStaticMarkup(<DeploymentBadge environment="qa" />);
    expect(html).toContain('data-deployment="unknown"');
    expect(html).toContain(">Unknown<");
  });
});
