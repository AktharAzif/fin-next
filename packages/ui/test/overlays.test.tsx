// overlays/: Modal, ConfirmDialog, Tabs and TabLinks, PageHeader, EmptyState, SecretReveal, Toaster.
import { tabs as tabsPrimitive } from "@ui-sdk/core/tabs";
import { createTabsController, type TabsOptions } from "@ui-sdk/react/tabs";
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from "react";
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
  TabLinkTargetProps,
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
  /** The attribute names on an opening tag, sorted. */
  const attributeNames = (tag: string | undefined) =>
    [...(tag ?? "").matchAll(/\s([a-zA-Z][\w:-]*)(?==")/g)].map((match) => match[1]).sort();

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
    // The chosen tab carries the mark in the primary colour; the others are secondary, and lift on
    // hover.
    expect(classes(tabs[1])).toEqual(
      expect.arrayContaining(["text-text-primary", "after:opacity-100"]),
    );
    expect(classes(tabs[0])).toEqual(
      expect.arrayContaining(["text-text-secondary", "after:opacity-0", "hover:text-text-primary"]),
    );
  });

  it("tab links are a named navigation holding a list, one item per link, the current marked", () => {
    const html = render(
      <TabLinks label="Settings">
        <TabLink href="/settings/organisation" current>
          Organisation
        </TabLink>
        <TabLink href="/settings/team">Team</TabLink>
      </TabLinks>,
    );
    // nav > ul > li > a, one item per link, nothing else in between.
    expect(html).toMatch(
      /^<nav aria-label="Settings"[^>]*><ul [^>]*>(?:<li [^>]*><a [^>]*>[^<]+<\/a><\/li>){2}<\/ul><\/nav>$/,
    );
    expect(classes(html.match(/<ul\b[^>]*>/)?.[0])).toEqual(
      expect.arrayContaining(["list-none", "m-0"]),
    );
    expect(tagsWith(html, "aria-current", "page")).toHaveLength(1);
    expect(attr(tagsWith(html, "aria-current", "page")[0], "href")).toBe("/settings/organisation");
    expect(attr(tagsWith(html, "href", "/settings/team")[0], "aria-current")).toBeUndefined();
    expect(classes(tagsWith(html, "href", "/settings/team")[0])).toContain(
      "hover:text-text-primary",
    );
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
    expect(classes(people)).toEqual(
      expect.arrayContaining(["text-text-disabled", "cursor-not-allowed"]),
    );
  });

  it("a disabled tab that value or defaultValue names still looks unavailable, with no mark", () => {
    for (const named of [{ defaultValue: "people" }, { value: "people" }]) {
      const html = render(
        <Tabs {...named}>
          <TabsList aria-label="Customer">
            <Tab value="people" disabled>
              People
            </Tab>
            <Tab value="overview">Overview</Tab>
          </TabsList>
        </Tabs>,
      );
      const people = classes(tagsWith(html, "role", "tab")[0]);
      expect(people, JSON.stringify(named)).toEqual(
        expect.arrayContaining(["text-text-disabled", "after:opacity-0", "cursor-not-allowed"]),
      );
      expect(people, JSON.stringify(named)).not.toContain("text-text-primary");
      expect(people, JSON.stringify(named)).not.toContain("after:opacity-100");
      expect(people.filter((name) => name.startsWith("hover:"))).toEqual([]);
    }
  });

  it("a count is the number as given, however large, and never 0 or less", () => {
    const html = render(
      <Tabs defaultValue="money">
        <TabsList aria-label="Customer">
          <Tab value="money" count={1234}>
            Money
          </Tab>
          <Tab value="documents" count={-2}>
            Documents
          </Tab>
          <Tab value="activity" count={0}>
            Activity
          </Tab>
        </TabsList>
      </Tabs>,
    );
    const counts = tagsWith(html, "data-slot", "tab-count");
    expect(counts).toHaveLength(1);
    expect(text(html)).toContain("Money1234");
    expect(text(html)).not.toContain("1,234");
    expect(text(html)).not.toContain("-2");
    expect(text(html)).not.toContain("Activity0");
  });

  it("under a page header the row keeps to its own box and a panel starts 24px down", () => {
    const html = render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Customer">
          <Tab value="overview">Overview</Tab>
        </TabsList>
        <TabPanel value="overview">Overview panel</TabPanel>
      </Tabs>,
    );
    const row = classes(tagsWith(html, "role", "tablist")[0]);
    expect(row).toEqual(
      expect.arrayContaining(["min-w-0", "overflow-x-auto", "border-b", "border-border"]),
    );
    // No margin at all, so none can widen a scroll container or clip the first tab's ring.
    expect(row.filter((name) => /^-?m[xylrtbse]?-/.test(name))).toEqual([]);
    expect(classes(tagsWith(html, "role", "tabpanel")[0])).toContain("pt-6");
    // The root may shrink below its row and never grows past its parent, and is a column, so a
    // panel given flex-1 fills the height left under the row.
    expect(classes(tagsWith(html, "data-slot", "tabs")[0])).toEqual(
      expect.arrayContaining(["min-w-0", "max-w-full", "flex", "flex-col"]),
    );
    // The row is a scroll container, which a column may shrink to nothing: it never shrinks.
    expect(row).toEqual(expect.arrayContaining(["shrink-0", "max-w-full"]));
    const links = render(
      <TabLinks label="Customer">
        <TabLink href="/customers/c1" current>
          Overview
        </TabLink>
      </TabLinks>,
    );
    expect(classes(links.match(/<nav\b[^>]*>/)?.[0])).toEqual(
      expect.arrayContaining(["min-w-0", "max-w-full", "border-b"]),
    );
    const list = classes(links.match(/<ul\b[^>]*>/)?.[0]);
    expect(list).toContain("overflow-x-auto");
    expect(list.filter((name) => /^-m/.test(name))).toEqual([]);
    // With no variant the links take the page's row: no side padding, the markup of `page` itself.
    expect(list.filter((name) => /^p[xlrse]?-/.test(name))).toEqual([]);
    expect(links).toBe(
      render(
        <TabLinks label="Customer" variant="page">
          <TabLink href="/customers/c1" current>
            Overview
          </TabLink>
        </TabLinks>,
      ),
    );
    // Each item is a flex box, so its link is a flex item and no inherited line height adds to it.
    expect(classes(links.match(/<li\b[^>]*>/)?.[0])).toContain("flex");
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
    expect(list).toEqual(expect.arrayContaining(["min-w-0", "px-4", "overflow-x-auto"]));
    expect(list.filter((name) => /^-m/.test(name))).toEqual([]);
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
    expect(row.filter((name) => /^-m/.test(name))).toEqual([]);
  });

  it("a panel draws its focus ring inside, in a drawer and under a page header alike", () => {
    for (const variant of ["page", "drawer"] as const) {
      const panel = classes(
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
      expect(panel, variant).toContain("focus-visible:outline-focus-inset");
      expect(panel, variant).not.toContain("focus-visible:outline-focus");
    }
  });

  it("every part's className lands on its own element, a class of the same family replacing", () => {
    const html = render(
      <>
        <Tabs defaultValue="overview" variant="drawer" className="flex-row">
          <TabsList aria-label="Customer" className="mt-4 px-8 shrink">
            <Tab value="overview" className="h-8">
              Overview
            </Tab>
          </TabsList>
          <TabPanel value="overview" className="py-2">
            Overview panel
          </TabPanel>
        </Tabs>
        <TabLinks label="Settings" className="border-transparent">
          <TabLink href="/settings/team" current className="text-text-tertiary">
            Team
          </TabLink>
        </TabLinks>
      </>,
    );
    const root = classes(tagsWith(html, "data-slot", "tabs")[0]);
    expect(root).toContain("flex-row");
    expect(root).not.toContain("flex-col");
    const list = classes(tagsWith(html, "role", "tablist")[0]);
    expect(list).toEqual(expect.arrayContaining(["mt-4", "px-8", "shrink", "border-b"]));
    expect(list).not.toContain("px-4");
    expect(list).not.toContain("shrink-0");
    const tab = classes(tagsWith(html, "role", "tab")[0]);
    expect(tab).toContain("h-8");
    expect(tab).not.toContain("h-10");
    const panel = classes(tagsWith(html, "role", "tabpanel")[0]);
    expect(panel).toEqual(expect.arrayContaining(["py-2", "px-6"]));
    expect(panel).not.toContain("py-5");
    const nav = classes(html.match(/<nav\b[^>]*>/)?.[0]);
    expect(nav).toEqual(expect.arrayContaining(["border-transparent", "border-b"]));
    expect(nav).not.toContain("border-border");
    const link = classes(tagsWith(html, "href", "/settings/team")[0]);
    expect(link).toContain("text-text-tertiary");
    expect(link).not.toContain("text-text-primary");
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
    expect(classes(tagsWith(html, "role", "tablist")[0])).toContain("mt-4");
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
    // A tag name serves as the link too.
    const tag = render(
      <TabLinks label="Settings" linkAs="a">
        <TabLink href="/settings/team">Team</TabLink>
      </TabLinks>,
    );
    expect(attr(tagsWith(tag, "href", "/settings/team")[0], "class")).toContain("h-10");
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

  it("a kept panel stays in the page, hidden, while its tab isn't chosen; any other panel leaves", () => {
    const tree = (chosen: string) => (
      <Tabs defaultValue={chosen}>
        <TabsList aria-label="Comment">
          <Tab value="reply">Reply</Tab>
          <Tab value="formatting">Formatting</Tab>
          <Tab value="preview">Preview</Tab>
        </TabsList>
        <TabPanel value="reply" keepMounted>
          Reply draft
        </TabPanel>
        <TabPanel value="formatting">Formatting notes</TabPanel>
        <TabPanel value="preview">Preview text</TabPanel>
      </Tabs>
    );
    const away = render(tree("formatting"));
    const panels = tagsWith(away, "role", "tabpanel");
    expect(panels).toHaveLength(2);
    expect(text(away)).toContain("Reply draft");
    expect(text(away)).not.toContain("Preview text");
    // The plain hidden attribute takes the panel's box and its Tab stop away (until-found keeps
    // both); the chosen panel carries none.
    const [kept, chosen] = panels;
    expect(attr(kept, "hidden")).toBe("");
    expect(attr(chosen, "hidden")).toBeUndefined();
    // While it leaves, before the SDK hides or drops it, a panel takes no box either.
    for (const panel of panels) expect(classes(panel)).toContain("state-ending:hidden");
    // Chosen again, the kept panel shows like any other.
    const back = tagsWith(render(tree("reply")), "role", "tabpanel");
    expect(back).toHaveLength(1);
    expect(attr(back[0], "hidden")).toBeUndefined();
  });

  it("a part run out with a negative side margin takes max-w-none, which lifts its cap", () => {
    // In a parent that sizes it to its content, the part is stretched too: the class stays.
    const html = render(
      <>
        <Tabs
          variant="drawer"
          defaultValue="overview"
          className="-mx-6 max-w-none justify-self-stretch"
        >
          <TabsList aria-label="Customer" className="-mx-6 max-w-none">
            <Tab value="overview">Overview</Tab>
          </TabsList>
        </Tabs>
        <TabLinks label="Settings" className="-mx-6 max-w-none self-stretch">
          <TabLink href="/settings/team">Team</TabLink>
        </TabLinks>
      </>,
    );
    expect(classes(tagsWith(html, "data-slot", "tabs")[0])).toContain("justify-self-stretch");
    expect(classes(html.match(/<nav\b[^>]*>/)?.[0])).toContain("self-stretch");
    const parts = {
      root: tagsWith(html, "data-slot", "tabs")[0],
      list: tagsWith(html, "role", "tablist")[0],
      nav: html.match(/<nav\b[^>]*>/)?.[0],
    };
    for (const [part, tag] of Object.entries(parts)) {
      expect(classes(tag), part).toEqual(
        expect.arrayContaining(["-mx-6", "max-w-none", "min-w-0"]),
      );
      expect(classes(tag), part).not.toContain("max-w-full");
    }
  });

  it("hands the SDK only its named options, and onValueChange the SDK's details: cancel() keeps", () => {
    const asked: (string | null)[] = [];
    const onValueChange: NonNullable<TabsProps["onValueChange"]> = (next, details) => {
      asked.push(next);
      if (next === "money") details.cancel();
    };
    const controller = createTabsController();
    const smuggled: Record<string, unknown> = {
      orientation: "vertical",
      style: { color: "red" },
      render: <section />,
      dangerouslySetInnerHTML: { __html: "<img>" },
      debug: true,
      "data-smuggled": "",
      tabIndex: 5,
      // Left out: the SDK would keep each hidden panel's box and Tab stop.
      hiddenUntilFound: true,
    };
    // Tabs calls no hook, so calling it shows the element it hands the SDK's root.
    const element = Tabs({
      ...smuggled,
      value: "overview",
      defaultValue: "overview",
      onValueChange,
      activation: "manual",
      loop: false,
      controller,
      id: "customer-tabs",
      variant: "drawer",
      className: "gap-2",
      children: "Tabs",
    }) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
    const handed = element.props.children.props;
    expect(Object.keys(handed).sort()).toEqual(
      [
        "value",
        "defaultValue",
        "onValueChange",
        "activation",
        "loop",
        "controller",
        "id",
        "data-variant",
        "className",
        "children",
      ].sort(),
    );
    expect(handed.onValueChange).toBe(onValueChange);
    expect(handed.controller).toBe(controller);
    expect([handed.activation, handed.loop]).toEqual(["manual", false]);
    // The SDK runs the change with the handler Tabs handed it: cancel() keeps the selection.
    const sdk = tabsPrimitive({
      id: "customer",
      defaultValue: "overview",
      onValueChange: handed.onValueChange as typeof onValueChange,
    });
    expect(sdk.api.select("money")).toBe(false);
    expect(sdk.get().value).toBe("overview");
    expect(sdk.api.select("activity")).toBe(true);
    expect(sdk.get().value).toBe("activity");
    expect(asked).toEqual(["money", "activity"]);
    // The root takes an id; the tabs keep their own.
    const html = render(
      <Tabs id="customer-tabs" defaultValue="overview">
        <TabsList aria-label="Customer">
          <Tab value="overview">Overview</Tab>
        </TabsList>
      </Tabs>,
    );
    expect(attr(tagsWith(html, "data-slot", "tabs")[0], "id")).toBe("customer-tabs");
  });

  it("the tablist hands the SDK only its name", () => {
    const smuggled: Record<string, unknown> = {
      id: "smuggled-id",
      title: "smuggled-title",
      style: { color: "red" },
      tabIndex: 5,
      role: "presentation",
      "data-smuggled": "",
      "aria-hidden": "true",
      "aria-describedby": "smuggled-description",
      onKeyDown: noop,
      dangerouslySetInnerHTML: { __html: "<img data-raw-markup>" },
      render: <section data-swapped="" />,
    };
    const own = ["class", "data-activation-direction", "data-orientation", "data-slot", "role"];
    const byLabel = render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Customer" {...smuggled}>
          <Tab value="a">A</Tab>
        </TabsList>
      </Tabs>,
    );
    const labelled = tagsWith(byLabel, "role", "tablist")[0];
    expect(attributeNames(labelled)).toEqual(["aria-label", ...own].sort());
    expect(attr(labelled, "role")).toBe("tablist");
    const byElement = render(
      <Tabs defaultValue="a">
        <TabsList aria-labelledby="customer-name" {...smuggled}>
          <Tab value="a">A</Tab>
        </TabsList>
      </Tabs>,
    );
    expect(attributeNames(tagsWith(byElement, "role", "tablist")[0])).toEqual(
      ["aria-labelledby", ...own].sort(),
    );
    expect(byLabel + byElement).not.toContain("smuggled");
  });

  it("hands nothing past its own props to the markup, even through a spread tsc cannot check", () => {
    // Everything here is outside every part's prop list. A spread skips the excess-property
    // check, so only the parts themselves can keep these out.
    const foreign: Record<string, unknown> = {
      title: "smuggled-title",
      style: { color: "red" },
      tabIndex: 5,
      role: "presentation",
      "data-smuggled": "",
      "aria-hidden": "true",
      "aria-describedby": "smuggled-description",
      orientation: "vertical",
      // Find in page: with it the SDK would render every hidden panel, and `hidden=` with it.
      hiddenUntilFound: true,
      target: "_blank",
      onClick: noop,
      dangerouslySetInnerHTML: { __html: "<img data-raw-markup>" },
      render: <section data-swapped="" />,
    };
    // Each of these belongs to one part only, and must never reach the others.
    const owned: Record<string, unknown> = {
      id: "smuggled-id",
      keepMounted: true,
      count: 777,
      linkAs: ({ href }: { href: string }) => <b data-smuggled-link="">{href}</b>,
    };
    const smuggle = (...own: string[]): Record<string, unknown> => ({
      ...foreign,
      ...Object.fromEntries(Object.entries(owned).filter(([name]) => !own.includes(name))),
    });
    // A part's children are content; a function of the SDK's state, typed past tsc here, is
    // refused at run time too.
    const functionChild = { children: (() => "function content") as unknown as ReactNode };
    function SpreadLink(props: Record<string, unknown>) {
      return <a data-link="" {...props} />;
    }
    const html = render(
      <>
        <Tabs defaultValue="overview" {...smuggle("id")}>
          <TabsList aria-label="Customer" {...smuggle()}>
            <Tab value="overview" {...smuggle("count")}>
              Overview
            </Tab>
            <Tab value="money" count={3} {...smuggle("count")}>
              Money
            </Tab>
          </TabsList>
          <TabPanel value="overview" {...smuggle("keepMounted")}>
            Overview panel
          </TabPanel>
          <TabPanel value="money" {...smuggle("keepMounted")} keepMounted={false}>
            Money panel
          </TabPanel>
        </Tabs>
        <Tabs defaultValue="a" {...functionChild} />
        <Tabs defaultValue="a">
          <TabsList aria-label="Other" {...functionChild} />
          <TabPanel value="a" {...functionChild} />
        </Tabs>
        {/* TabLinks does take a link component, so the smuggled one comes first and is replaced. */}
        <TabLinks {...smuggle("linkAs")} label="Settings" linkAs={SpreadLink}>
          <TabLink href="/settings/team" current {...smuggle()}>
            Team
          </TabLink>
          <TabLink href="/settings/roles" {...smuggle()}>
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
      "aria-describedby",
      'aria-orientation="vertical"',
      'data-orientation="vertical"',
      "target=",
      "data-raw-markup",
      "<section",
      "data-swapped",
      "function content",
      "777",
      "hidden=",
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
      <Tabs key="1" value={null}>
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
      // @ts-expect-error: no part takes `style`
      <Tabs key="6" style={{}}>
        x
      </Tabs>,
      <Tabs
        key="7"
        // @ts-expect-error: no part takes raw markup
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the line proves tsc refuses it
        dangerouslySetInnerHTML={{ __html: "" }}
      >
        x
      </Tabs>,
      // @ts-expect-error: no part takes DOM event handlers
      <Tabs key="8" onClick={noop}>
        x
      </Tabs>,
      // @ts-expect-error: the root's children are content, and required
      <Tabs key="9" />,
      // @ts-expect-error: the tablist needs a name
      <TabsList key="10">x</TabsList>,
      // @ts-expect-error: one name, not two
      <TabsList key="11" aria-label="Customer" aria-labelledby="customer-name">
        x
      </TabsList>,
      // @ts-expect-error: only the root takes an id
      <TabsList key="12" aria-label="Customer" id="list">
        x
      </TabsList>,
      // @ts-expect-error: no part takes `style`
      <Tab key="13" value="a" style={{}}>
        A
      </Tab>,
      // @ts-expect-error: only the root takes an id
      <Tab key="14" value="a" id="tab">
        A
      </Tab>,
      // @ts-expect-error: the SDK owns the tab stop
      <Tab key="15" value="a" tabIndex={0}>
        A
      </Tab>,
      // @ts-expect-error: a tab is always a <button>
      <Tab key="16" value="a" render={<a href="/a" />}>
        A
      </Tab>,
      // @ts-expect-error: a tab needs its label
      <Tab key="17" value="a" />,
      <TabPanel key="18" value="a">
        {
          // @ts-expect-error: a panel's children are content, not a function of state
          () => "A"
        }
      </TabPanel>,
      // @ts-expect-error: only the root takes an id
      <TabPanel key="19" value="a" id="panel">
        A
      </TabPanel>,
      // @ts-expect-error: no part takes find in page (hidden panels would keep a box and a Tab stop)
      <TabPanel key="20" value="a" hiddenUntilFound>
        A
      </TabPanel>,
      // @ts-expect-error: no part takes `style`
      <TabLinks key="21" label="Settings" style={{}}>
        x
      </TabLinks>,
      // @ts-expect-error: the link component comes in once, on TabLinks
      <TabLink key="22" href="/a" linkAs={PlainLink}>
        A
      </TabLink>,
      // @ts-expect-error: a tab link carries no count
      <TabLink key="23" href="/a" count={3}>
        A
      </TabLink>,
      // @ts-expect-error: a tab link stays in this window
      <TabLink key="24" href="/a" target="_blank">
        A
      </TabLink>,
      // @ts-expect-error: a tab link needs its label
      <TabLink key="25" href="/a" />,
      // @ts-expect-error: no part takes find in page, the root included
      <Tabs key="26" hiddenUntilFound>
        x
      </Tabs>,
    ];
    expect(elements).toHaveLength(26);
    // onValueChange is typed exactly as the SDK types it, details and all.
    type Same<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const exact: Same<
      NonNullable<TabsProps["onValueChange"]>,
      NonNullable<TabsOptions["onValueChange"]>
    > = true;
    expect(exact).toBe(true);
    // Each part's whole prop list: a prop added to a part (`style`, raw markup, any SDK or DOM
    // pass-through) makes its record incomplete, and tsc fails here.
    const lists: {
      tabs: Record<keyof TabsProps, true>;
      list: Record<keyof TabsListProps, true>;
      tab: Record<keyof TabProps, true>;
      panel: Record<keyof TabPanelProps, true>;
      links: Record<keyof TabLinksProps, true>;
      link: Record<keyof TabLinkProps, true>;
      target: Record<keyof TabLinkTargetProps, true>;
    } = {
      tabs: {
        value: true,
        defaultValue: true,
        onValueChange: true,
        activation: true,
        loop: true,
        controller: true,
        id: true,
        variant: true,
        className: true,
        children: true,
      },
      list: { "aria-label": true, "aria-labelledby": true, className: true, children: true },
      tab: { value: true, disabled: true, count: true, className: true, children: true },
      panel: { value: true, keepMounted: true, className: true, children: true },
      links: { label: true, variant: true, linkAs: true, className: true, children: true },
      link: { href: true, current: true, className: true, children: true },
      target: { href: true, className: true, "aria-current": true, children: true },
    };
    expect(Object.keys(lists)).toHaveLength(7);
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
