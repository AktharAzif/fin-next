// overlays/: Modal, ConfirmDialog, Tabs and TabLinks, PageHeader, EmptyState, SecretReveal, Toaster.
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
    toast.success("Webhook created");
    toast.info("Fin was updated");
    expect(toast.count()).toBe(3);
    toast("Key copied");
    expect(toast.count()).toBe(3);
    toast("Saved");
    toast("Done");
    expect(toast.count()).toBe(3);
    expect(error).toBeTruthy();
    toast.dismiss();
    expect(toast.count()).toBe(0);
  });

  it("evicts the oldest when every toast is an error", () => {
    toast.dismiss();
    toast.error("One");
    toast.error("Two");
    toast.error("Three");
    toast.error("Four");
    expect(toast.count()).toBe(3);
    toast.dismiss();
  });
});
