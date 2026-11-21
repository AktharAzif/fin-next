// overlays/: Modal, ConfirmDialog, Tabs and TabLinks, PageHeader, EmptyState, SecretReveal, Toaster.
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  Badge,
  Button,
  ConfirmDialog,
  DocsLink,
  EmptyState,
  Modal,
  PageHeader,
  SecretReveal,
  Tab,
  TabLink,
  TabLinks,
  TabPanel,
  Tabs,
  TabsList,
  Toaster,
  toast,
} from "../src/index.ts";
import type {
  TabLinkProps,
  TabLinksProps,
  TabPanelProps,
  TabProps,
  TabsListProps,
  TabsProps,
} from "../src/overlays/tabs.tsx";
import { PlainLink } from "../src/shell/index.ts";
import { attr, classes, render, tagsWith, text } from "./html.ts";

const noop = () => {};

describe("Modal", () => {
  it("renders nothing while closed", () => {
    expect(render(<Modal open={false} onOpenChange={noop} title="Create API key" />)).toBe("");
  });

  it("is a modal dialog named by its title, 480 wide with 24 padding, with a Close button", () => {
    const html = render(
      <Modal
        open
        onOpenChange={noop}
        title="Create API key"
        description="Shown once."
        footer={<Button>Create key</Button>}
      >
        Body
      </Modal>,
    );
    const [dialog] = tagsWith(html, "role", "dialog");
    expect(attr(dialog, "aria-modal")).toBe("true");
    const [title] = tagsWith(html, "data-slot", "dialog-title");
    expect(attr(dialog, "aria-labelledby")).toBe(attr(title, "id"));
    expect(attr(title, "tabindex")).toBe("-1");
    expect(classes(dialog)).toEqual(
      expect.arrayContaining(["max-w-modal", "p-modal-padding", "inset-x-4"]),
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('data-slot="dialog-backdrop"');
  });

  it("says busy, and its Close does nothing while busy", () => {
    const html = render(<Modal open busy onOpenChange={noop} title="Creating" />);
    expect(attr(tagsWith(html, "role", "dialog")[0], "aria-busy")).toBe("true");
    const [close] = tagsWith(html, "aria-label", "Close");
    expect(close).toMatch(/\sdisabled=""/);
  });
});

describe("ConfirmDialog", () => {
  const base = {
    open: true,
    onOpenChange: noop,
    title: "Delete this webhook?",
    description: "Events stop going to https://example.com/hooks. This can’t be undone.",
    confirmLabel: "Delete webhook",
    onConfirm: noop,
  };

  it("is an alert dialog with no X: a question, Cancel, then the verb", () => {
    const html = render(<ConfirmDialog {...base} tone="danger" />);
    expect(tagsWith(html, "role", "alertdialog")).toHaveLength(1);
    expect(html).not.toContain('aria-label="Close"');
    const buttons = tagsWith(html, "data-slot", "button");
    expect(text(html)).toMatch(/Cancel.*Delete webhook$/);
    expect(classes(buttons.at(-1))).toContain("bg-danger-solid");
  });

  it("keeps the confirm unavailable until the name is typed", () => {
    const html = render(
      <ConfirmDialog {...base} confirmText="acme-hooks" cue="This deletes it in Production." />,
    );
    expect(text(html)).toContain("Type acme-hooks to confirm");
    expect(text(html)).toContain("This deletes it in Production.");
    const confirm = tagsWith(html, "data-slot", "button").at(-1);
    expect(attr(confirm, "aria-disabled")).toBe("true");
  });

  it("spins while busy and shows the last attempt's error", () => {
    const html = render(<ConfirmDialog {...base} busy error="Couldn’t delete the webhook." />);
    expect(attr(tagsWith(html, "data-slot", "button").at(-1), "aria-busy")).toBe("true");
    expect(text(html)).toContain("Couldn’t delete the webhook.");
  });
});

describe("Tabs and TabLinks", () => {
  it("tabs select the first and show counts only for waiting work", () => {
    const html = render(
      <Tabs defaultValue="money">
        <TabsList aria-label="Customer">
          <Tab value="overview">Overview</Tab>
          <Tab value="money" count={3}>
            Money
          </Tab>
          <Tab value="activity" count={0}>
            Activity
          </Tab>
        </TabsList>
        <TabPanel value="money">Money panel</TabPanel>
      </Tabs>,
    );
    const tabs = tagsWith(html, "role", "tab");
    expect(tabs).toHaveLength(3);
    expect(attr(tabs[1], "aria-selected")).toBe("true");
    expect(text(html)).toContain("Money3");
    expect(text(html)).not.toContain("Activity0");
  });

  it("tab links are a named navigation with the current page marked", () => {
    const html = render(
      <TabLinks label="Settings">
        <TabLink href="/settings/organisation" current>
          Organisation
        </TabLink>
        <TabLink href="/settings/team">Team</TabLink>
      </TabLinks>,
    );
    expect(html).toContain('<nav aria-label="Settings"');
    expect(tagsWith(html, "aria-current", "page")).toHaveLength(1);
    expect(attr(tagsWith(html, "aria-current", "page")[0], "href")).toBe("/settings/organisation");
  });

  it("the tablist carries the name it is given, by label or by a labelling element", () => {
    const labelled = render(
      <Tabs>
        <TabsList aria-label="Customer">
          <Tab value="overview">Overview</Tab>
        </TabsList>
      </Tabs>,
    );
    expect(attr(tagsWith(labelled, "role", "tablist")[0], "aria-label")).toBe("Customer");
    const byElement = render(
      <Tabs>
        <TabsList aria-labelledby="customer-name">
          <Tab value="overview">Overview</Tab>
        </TabsList>
      </Tabs>,
    );
    expect(attr(tagsWith(byElement, "role", "tablist")[0], "aria-labelledby")).toBe(
      "customer-name",
    );
  });

  it("a disabled tab is marked disabled and is not chosen first", () => {
    const html = render(
      <Tabs>
        <TabsList aria-label="Customer">
          <Tab value="people" disabled>
            People
          </Tab>
          <Tab value="overview">Overview</Tab>
        </TabsList>
        <TabPanel value="people">People panel</TabPanel>
        <TabPanel value="overview">Overview panel</TabPanel>
      </Tabs>,
    );
    const [people, overview] = tagsWith(html, "role", "tab");
    expect(attr(people, "aria-disabled")).toBe("true");
    expect(attr(people, "aria-selected")).toBe("false");
    expect(attr(overview, "aria-selected")).toBe("true");
    expect(text(html)).toContain("Overview panel");
    expect(text(html)).not.toContain("People panel");
  });

  it("a count is the plain number, however large, and never 0 or less", () => {
    const html = render(
      <Tabs defaultValue="money">
        <TabsList aria-label="Customer">
          <Tab value="money" count={1234}>
            Money
          </Tab>
          <Tab value="documents" count={-2}>
            Documents
          </Tab>
        </TabsList>
      </Tabs>,
    );
    const counts = tagsWith(html, "data-slot", "tab-count");
    expect(counts).toHaveLength(1);
    expect(text(html)).toContain("Money1234");
    expect(text(html)).not.toContain("1,234");
    expect(text(html)).not.toContain("-2");
    const links = render(
      <TabLinks label="Customer">
        <TabLink href="/customers/c1?tab=documents" count={1000}>
          Documents
        </TabLink>
        <TabLink href="/customers/c1?tab=activity" count={0}>
          Activity
        </TabLink>
      </TabLinks>,
    );
    expect(text(links)).toContain("Documents1000");
    expect(text(links)).not.toContain("Activity0");
  });

  it("under a page header the row pulls back to the content edge and a panel starts 24px down", () => {
    const html = render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Customer">
          <Tab value="overview">Overview</Tab>
        </TabsList>
        <TabPanel value="overview">Overview panel</TabPanel>
      </Tabs>,
    );
    expect(classes(tagsWith(html, "role", "tablist")[0])).toEqual(
      expect.arrayContaining(["-mx-2", "overflow-x-auto"]),
    );
    expect(classes(tagsWith(html, "role", "tabpanel")[0])).toContain("pt-6");
    // The root is a column, so a panel given flex-1 fills the height left under the row.
    expect(classes(tagsWith(html, "data-slot", "tabs")[0])).toEqual(
      expect.arrayContaining(["flex", "flex-col"]),
    );
  });

  it("in a drawer the row and its panels sit 24px in, for tabs and for tab links", () => {
    const html = render(
      <Tabs defaultValue="overview" variant="drawer">
        <TabsList aria-label="Customer">
          <Tab value="overview">Overview</Tab>
        </TabsList>
        <TabPanel value="overview">Overview panel</TabPanel>
      </Tabs>,
    );
    const list = classes(tagsWith(html, "role", "tablist")[0]);
    expect(list).toEqual(expect.arrayContaining(["px-4", "overflow-x-auto"]));
    expect(list).not.toContain("-mx-2");
    expect(classes(tagsWith(html, "role", "tabpanel")[0])).toEqual(
      expect.arrayContaining(["px-6", "py-5"]),
    );
    const links = render(
      <TabLinks label="Customer" variant="drawer">
        <TabLink href="/customers/c1" current>
          Overview
        </TabLink>
      </TabLinks>,
    );
    const row = classes(links.match(/<ul\b[^>]*>/)?.[0]);
    expect(row).toEqual(expect.arrayContaining(["px-4", "overflow-x-auto"]));
    expect(row).not.toContain("-mx-2");
  });

  it("a caller's className wins: a panel's own padding, a row's margin", () => {
    const html = render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Customer" className="mt-4">
          <Tab value="overview">Overview</Tab>
        </TabsList>
        <TabPanel value="overview" className="pt-2">
          Overview panel
        </TabPanel>
      </Tabs>,
    );
    const panel = classes(tagsWith(html, "role", "tabpanel")[0]);
    expect(panel).toContain("pt-2");
    expect(panel).not.toContain("pt-6");
    expect(classes(tagsWith(html, "data-slot", "tabs-row")[0])).toContain("mt-4");
  });

  it("tab links render through the app's link, the current one marked", () => {
    function RouterishLink(props: {
      href: string;
      className?: string;
      children?: ReactNode;
      "aria-current"?: "page";
    }) {
      return <a data-router="" {...props} />;
    }
    const html = render(
      <TabLinks label="Settings" linkAs={RouterishLink}>
        <TabLink href="/settings/organisation" current>
          Organisation
        </TabLink>
        <TabLink href="/settings/team">Team</TabLink>
      </TabLinks>,
    );
    const links = tagsWith(html, "data-router");
    expect(links.map((tag) => attr(tag, "href"))).toEqual([
      "/settings/organisation",
      "/settings/team",
    ]);
    expect(attr(links[0], "aria-current")).toBe("page");
    expect(attr(links[1], "aria-current")).toBeUndefined();
    expect(classes(links[0])).toContain("h-10");
  });

  it("follows a controlled value: the page's choice is the chosen tab, and null chooses none", () => {
    const tree = (value: string | null) => (
      <Tabs value={value} defaultValue="overview">
        <TabsList aria-label="Customer">
          <Tab value="overview">Overview</Tab>
          <Tab value="money">Money</Tab>
        </TabsList>
        <TabPanel value="overview">Overview panel</TabPanel>
        <TabPanel value="money">Money panel</TabPanel>
      </Tabs>
    );
    const money = render(tree("money"));
    const [overview, moneyTab] = tagsWith(money, "role", "tab");
    expect(attr(moneyTab, "aria-selected")).toBe("true");
    expect(attr(overview, "aria-selected")).toBe("false");
    expect(text(money)).toContain("Money panel");
    expect(text(money)).not.toContain("Overview panel");
    const none = render(tree(null));
    expect(tagsWith(none, "aria-selected", "true")).toHaveLength(0);
    expect(tagsWith(none, "role", "tabpanel")).toHaveLength(0);
  });

  it("in a drawer a panel draws its focus ring inside, where the drawer's edge cannot cut it", () => {
    const panel = (variant: "page" | "drawer") =>
      classes(
        tagsWith(
          render(
            <Tabs defaultValue="overview" variant={variant}>
              <TabsList aria-label="Customer">
                <Tab value="overview">Overview</Tab>
              </TabsList>
              <TabPanel value="overview">Overview panel</TabPanel>
            </Tabs>,
          ),
          "role",
          "tabpanel",
        )[0],
      );
    expect(panel("drawer")).toContain("focus-visible:outline-focus-inset");
    expect(panel("page")).not.toContain("focus-visible:outline-focus-inset");
  });

  it("hands nothing past its own props to the markup, even through a spread tsc cannot check", () => {
    // Everything here is outside every part's prop list. A spread skips the excess-property
    // check, so only the parts themselves can keep these out.
    const smuggled: Record<string, unknown> = {
      id: "smuggled-id",
      title: "smuggled-title",
      style: { color: "red" },
      tabIndex: 5,
      role: "presentation",
      "data-smuggled": "",
      "aria-hidden": "true",
      "aria-describedby": "smuggled-description",
      orientation: "vertical",
      keepMounted: true,
      hiddenUntilFound: true,
      linkAs: ({ href }: { href: string }) => <b data-smuggled-link="">{href}</b>,
      target: "_blank",
      onClick: noop,
      dangerouslySetInnerHTML: { __html: "<img data-raw-markup>" },
      render: <section data-swapped="" />,
    };
    // A panel's children are content; a function of the SDK's state is refused at run time too.
    const functionChild: Record<string, unknown> = { children: () => "function content" };
    function SpreadLink(props: Record<string, unknown>) {
      return <a data-link="" {...props} />;
    }
    const html = render(
      <>
        <Tabs defaultValue="overview" {...smuggled}>
          <TabsList aria-label="Customer" {...smuggled}>
            <Tab value="overview" {...smuggled}>
              Overview
            </Tab>
            <Tab value="money" count={3} {...smuggled}>
              Money
            </Tab>
          </TabsList>
          <TabPanel value="overview" {...smuggled}>
            Overview panel
          </TabPanel>
          <TabPanel value="money" {...smuggled}>
            Money panel
          </TabPanel>
        </Tabs>
        <Tabs defaultValue="a" {...functionChild} />
        <Tabs defaultValue="a">
          <TabsList aria-label="Other" {...functionChild} />
          <TabPanel value="a" {...functionChild} />
        </Tabs>
        {/* TabLinks does take a link component, so the smuggled one comes first and is replaced. */}
        <TabLinks {...smuggled} label="Settings" linkAs={SpreadLink}>
          <TabLink href="/settings/team" current {...smuggled}>
            Team
          </TabLink>
          <TabLink href="/settings/roles" {...smuggled}>
            Roles
          </TabLink>
        </TabLinks>
      </>,
    );
    for (const leak of [
      "smuggled",
      "style=",
      'tabindex="5"',
      'role="presentation"',
      "aria-hidden",
      'aria-orientation="vertical"',
      'data-orientation="vertical"',
      "target=",
      "data-raw-markup",
      "<section",
      "data-swapped",
      "function content",
    ]) {
      expect(html, leak).not.toContain(leak);
    }
    // The parts still drew themselves: two tablists, the chosen panel, both links.
    expect(tagsWith(html, "role", "tablist")).toHaveLength(2);
    expect(text(html)).toContain("Overview panel");
    expect(text(html)).not.toContain("Money panel");
    expect(tagsWith(html, "data-link").map((tag) => attr(tag, "href"))).toEqual([
      "/settings/team",
      "/settings/roles",
    ]);
  });

  it("takes only the props the screens need (tsc checks these lines)", () => {
    const link = (props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
      <a {...props} />
    );
    const elements = [
      <Tabs key="1">
        <TabsList aria-label="Customer">
          <Tab value="a">A</Tab>
        </TabsList>
      </Tabs>,
      <TabLinks key="2" label="Settings" linkAs={PlainLink}>
        <TabLink href="/a">A</TabLink>
      </TabLinks>,
      <TabLinks key="3" label="Settings" linkAs={link}>
        <TabLink href="/a">A</TabLink>
      </TabLinks>,
      // @ts-expect-error: the tabs are horizontal (the design leaves out `orientation`)
      <Tabs key="4" orientation="vertical">
        x
      </Tabs>,
      // @ts-expect-error: the root is always a <div>
      <Tabs key="5" render={<section />}>
        x
      </Tabs>,
      // @ts-expect-error: the tablist needs a name
      <TabsList key="6">x</TabsList>,
      // @ts-expect-error: no part takes `style`
      <Tab key="7" value="a" style={{}}>
        A
      </Tab>,
      <TabPanel key="9" value="a">
        {
          // @ts-expect-error: a panel's children are content, not a function of state
          () => "A"
        }
      </TabPanel>,
      // @ts-expect-error: the link component comes in once, on TabLinks
      <TabLink key="10" href="/a" linkAs={PlainLink}>
        A
      </TabLink>,
    ];
    expect(elements).toHaveLength(9);
    // Each part's whole prop list: a prop added to a part (`style`, raw markup, any SDK or DOM
    // pass-through) makes its record incomplete, and tsc fails here.
    const lists: {
      tabs: Record<keyof TabsProps, true>;
      list: Record<keyof TabsListProps, true>;
      tab: Record<keyof TabProps, true>;
      panel: Record<keyof TabPanelProps, true>;
      links: Record<keyof TabLinksProps, true>;
      link: Record<keyof TabLinkProps, true>;
    } = {
      tabs: {
        value: true,
        defaultValue: true,
        onValueChange: true,
        variant: true,
        className: true,
        children: true,
      },
      list: { "aria-label": true, "aria-labelledby": true, className: true, children: true },
      tab: { value: true, disabled: true, count: true, className: true, children: true },
      panel: { value: true, className: true, children: true },
      links: { label: true, variant: true, linkAs: true, className: true, children: true },
      link: { href: true, current: true, count: true, className: true, children: true },
    };
    expect(Object.keys(lists)).toHaveLength(6);
  });
});

describe("PageHeader", () => {
  it("has one h1 that can take focus, breadcrumbs, meta and the primary action last", () => {
    const html = render(
      <PageHeader
        title="Webhooks"
        description="Get notified when payments change status."
        breadcrumbs={[{ label: "Developers", href: "/developers" }]}
        meta={<Badge>Sandbox</Badge>}
        actions={<Button variant="secondary">Export logs</Button>}
        primaryAction={<Button>Create webhook</Button>}
      />,
    );
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 tabindex="-1"/);
    expect(html).toContain('<nav aria-label="Breadcrumb"');
    expect(text(html).indexOf("Export logs")).toBeLessThan(text(html).indexOf("Create webhook"));
  });
});

describe("EmptyState", () => {
  it("draws an icon tile, the title and the action, with a docs link that says it opens a tab", () => {
    const html = render(
      <EmptyState
        variant="first-use"
        title="No webhooks yet"
        description="Get notified when payments change status."
        action={<Button>Create webhook</Button>}
        docs={{ label: "Read webhook docs", href: "https://example.com/docs" }}
      />,
    );
    expect(html).toContain("fin-ico--Tray");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(text(html)).toContain("(opens in a new tab)");
  });

  it("no-results shows removable filters and Clear filters", () => {
    const html = render(
      <EmptyState
        variant="no-results"
        title="No transactions match these filters"
        filters={[{ id: "s", label: "Status: Refunded", onRemove: noop }]}
        onClearFilters={noop}
      />,
    );
    expect(html).toContain('aria-label="Remove filter: Status: Refunded"');
    expect(text(html)).toContain("Clear filters");
  });

  it("section is one inline line", () => {
    const html = render(
      <EmptyState variant="section" title="No beneficiaries for this customer." />,
    );
    expect(html).toContain('data-variant="section"');
    expect(html).not.toContain("<h2");
  });

  it("DocsLink opens in a new tab and says so", () => {
    expect(text(render(<DocsLink href="https://example.com">API docs</DocsLink>))).toBe(
      "API docs (opens in a new tab)",
    );
  });
});

describe("SecretReveal", () => {
  it("ready: the warning, the values, the saved tick, Done unavailable until ticked", () => {
    const html = render(
      <SecretReveal status="ready" environment="Sandbox" clientId="cli_1" secret="sk_sandbox_2" />,
    );
    expect(text(html)).toContain("Copy your secret now");
    expect(html).toContain("Copy sandbox client secret");
    expect(html).toContain('role="checkbox"');
    expect(attr(tagsWith(html, "data-slot", "button").at(-1), "aria-disabled")).toBe("true");
  });

  it("masked: only the last four characters", () => {
    const html = render(
      <SecretReveal status="masked" environment="Production" secretLastFour="4f3a" />,
    );
    expect(text(html)).toContain("•••• 4f3a");
  });

  it("failed: the reason and Try again", () => {
    const html = render(
      <SecretReveal
        status="failed"
        environment="Sandbox"
        error="The OTP expired."
        onRetry={noop}
      />,
    );
    expect(text(html)).toContain("The OTP expired.");
    expect(text(html)).toContain("Try again");
  });
});

describe("Toaster and toast()", () => {
  it("is one region, bottom centre, F8, three at most", () => {
    const html = render(<Toaster />);
    expect(html).toContain('data-slot="toast-region"');
    expect(html).toContain('data-side="bottom"');
    expect(html).toContain('data-align="center"');
  });

  it("evicts the oldest non-error toast for a fourth, and keeps errors", () => {
    toast.dismiss();
    const error = toast.error("Couldn’t create webhook");
    const success = toast.success("Webhook created");
    const info = toast.info("Fin was updated");
    expect(toast.count()).toBe(3);
    const copied = toast("Key copied");
    expect(toast.count()).toBe(3);
    // The oldest non-error went, not the older error.
    expect([toast.has(error), toast.has(success), toast.has(info), toast.has(copied)]).toEqual([
      true,
      false,
      true,
      true,
    ]);
    const saved = toast("Saved");
    const done = toast("Done");
    expect(toast.count()).toBe(3);
    expect([error, saved, done].map((id) => toast.has(id))).toEqual([true, true, true]);
    expect([info, copied].map((id) => toast.has(id))).toEqual([false, false]);
    toast.dismiss();
    expect(toast.count()).toBe(0);
  });

  it("evicts the oldest when every toast is an error", () => {
    toast.dismiss();
    const one = toast.error("One");
    const rest = [toast.error("Two"), toast.error("Three"), toast.error("Four")];
    expect(toast.count()).toBe(3);
    expect(toast.has(one)).toBe(false);
    expect(rest.map((id) => toast.has(id))).toEqual([true, true, true]);
    toast.dismiss();
  });
});
