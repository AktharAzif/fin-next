// foundation/: Button, IconButton, TextButton, Spinner, Tooltip, Field, InlineAlert, Logo, Badge,
// StatusBadge, the Skeleton family, Avatar, CopyField and Checkbox, as static markup.
import { PlusIcon } from "@fin/icons";
import { describe, expect, it } from "vitest";
import {
  Avatar,
  Badge,
  Button,
  badgeHues,
  Checkbox,
  CopyField,
  Field,
  IconButton,
  InlineAlert,
  Input,
  initials,
  Logo,
  lowerFirst,
  middleTruncate,
  Skeleton,
  SkeletonPage,
  SkeletonSection,
  SkeletonText,
  Spinner,
  StatusBadge,
  Textarea,
  TextButton,
  Tooltip,
} from "../src/index.ts";
import { attr, classes, render, tagsWith, text } from "./html.ts";

describe("Button", () => {
  it("is a native button of type button, primary and 40px by default", () => {
    const html = render(<Button>Save</Button>);
    const [button] = tagsWith(html, "data-slot", "button");
    expect(attr(button, "type")).toBe("button");
    expect(classes(button)).toEqual(
      expect.arrayContaining(["bg-action-primary", "h-control-md", "rounded-control"]),
    );
    expect(text(html)).toBe("Save");
  });

  it("draws each variant and size from tokens only", () => {
    const variants = {
      primary: "bg-action-primary",
      secondary: "shadow-button",
      ghost: "bg-transparent",
      danger: "bg-danger-solid",
    } as const;
    for (const [variant, cls] of Object.entries(variants)) {
      const [tag] = tagsWith(
        render(<Button variant={variant as keyof typeof variants}>Go</Button>),
        "data-slot",
        "button",
      );
      expect(classes(tag)).toContain(cls);
    }
    const sizes = { sm: "h-control-sm", md: "h-control-md", lg: "h-control-lg" } as const;
    for (const [size, cls] of Object.entries(sizes)) {
      const [tag] = tagsWith(
        render(<Button size={size as keyof typeof sizes}>Go</Button>),
        "data-slot",
        "button",
      );
      expect(classes(tag)).toContain(cls);
    }
  });

  it("keeps the label while loading, shows a spinner, says busy and stays focusable", () => {
    const html = render(<Button loading>Create webhook</Button>);
    const [button] = tagsWith(html, "data-slot", "button");
    expect(attr(button, "aria-busy")).toBe("true");
    expect(attr(button, "aria-disabled")).toBe("true");
    expect(attr(button, "data-loading")).toBe("");
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('data-slot="spinner"');
    expect(text(html)).toBe("Create webhook");
  });

  it("disabled with a reason: focusable, with the reason in the page as its description", () => {
    const html = render(
      <Button disabledReason="Only admins can delete webhooks.">Delete webhook</Button>,
    );
    const [button] = tagsWith(html, "data-slot", "button");
    expect(attr(button, "aria-disabled")).toBe("true");
    expect(button).not.toMatch(/\sdisabled=""/);
    const [tip] = tagsWith(html, "role", "tooltip");
    expect(attr(button, "aria-describedby")).toBe(attr(tip, "id"));
    expect(html).toContain("Only admins can delete webhooks.");
  });

  it("plain disabled leaves the tab order", () => {
    const [button] = tagsWith(render(<Button disabled>Save</Button>), "data-slot", "button");
    expect(button).toMatch(/\sdisabled=""/);
  });

  it("draws leading and trailing icons around the label", () => {
    const html = render(<Button leadingIcon={<PlusIcon />}>New transfer</Button>);
    expect(html.indexOf("fin-ico--Plus")).toBeLessThan(html.indexOf("New transfer"));
  });
});

describe("IconButton", () => {
  it("is named by its tooltip, which is its label", () => {
    const html = render(<IconButton label="Copy transaction ID" icon={<PlusIcon />} />);
    const [button] = tagsWith(html, "data-slot", "button");
    const [tip] = tagsWith(html, "role", "tooltip");
    expect(attr(button, "aria-labelledby")).toBe(attr(tip, "id"));
    expect(text(html)).toBe("Copy transaction ID");
    expect(classes(button)).toEqual(expect.arrayContaining(["size-control-md", "bg-transparent"]));
  });

  it("takes an aria-label when the tooltip says something else, or nothing", () => {
    const other = render(<IconButton label="Copy" tooltip="trf_123" icon={<PlusIcon />} />);
    expect(attr(tagsWith(other, "data-slot", "button")[0], "aria-label")).toBe("Copy");
    const none = render(<IconButton label="Close" tooltip={false} icon={<PlusIcon />} />);
    expect(attr(tagsWith(none, "data-slot", "button")[0], "aria-label")).toBe("Close");
    expect(none).not.toContain('role="tooltip"');
  });

  it("has a 24px size for the edge toggle (UR-02)", () => {
    const [button] = tagsWith(
      render(
        <IconButton
          size="xs"
          variant="secondary"
          label="Collapse sidebar"
          icon={<PlusIcon />}
          className="rounded-full"
        />,
      ),
      "data-slot",
      "button",
    );
    expect(classes(button)).toEqual(
      expect.arrayContaining(["size-target-min", "shadow-button", "rounded-full"]),
    );
    expect(classes(button)).not.toContain("rounded-control");
  });

  it("swaps the icon for a spinner while loading", () => {
    const html = render(<IconButton loading label="Refresh" icon={<PlusIcon />} />);
    expect(html).toContain('data-slot="spinner"');
    expect(html).not.toContain("fin-ico--Plus");
  });
});

describe("TextButton, Spinner and Tooltip", () => {
  it("TextButton is an underlined button inside a sentence", () => {
    const [tag] = tagsWith(render(<TextButton>Retry</TextButton>), "data-slot", "button");
    expect(classes(tag)).toEqual(expect.arrayContaining(["underline", "text-label-sm"]));
  });

  it("Spinner is decorative and turns once every 600ms", () => {
    const [svg] = tagsWith(render(<Spinner />), "data-slot", "spinner");
    expect(attr(svg, "aria-hidden")).toBe("true");
    expect(classes(svg)).toContain("animate-spin-fin");
  });

  it("Tooltip keeps its text in the page, hidden, as the trigger's description", () => {
    const html = render(
      <Tooltip content="Opens the docs">
        <button type="button">Docs</button>
      </Tooltip>,
    );
    const [tip] = tagsWith(html, "role", "tooltip");
    expect(tip).toMatch(/\shidden=""/);
    expect(attr(tagsWith(html, "data-slot", "tooltip-trigger")[0], "aria-describedby")).toBe(
      attr(tip, "id"),
    );
  });

  it("Tooltip with no content renders the trigger alone", () => {
    expect(
      render(
        <Tooltip content="">
          <button type="button">x</button>
        </Tooltip>,
      ),
    ).toBe('<button type="button">x</button>');
  });
});

describe("Field", () => {
  it("names the control with a native label and describes it, error before helper", () => {
    const html = render(
      <Field
        label="Endpoint URL"
        error="Enter an https:// URL."
        helper="Fin posts events here."
        id="url"
      >
        <Input />
      </Field>,
    );
    expect(html).toContain('<label for="url"');
    const [input] = tagsWith(html, "data-slot", "input");
    expect(attr(input, "id")).toBe("url");
    expect(attr(input, "aria-describedby")).toBe("url-error url-helper");
    expect(attr(input, "aria-invalid")).toBe("true");
    expect(html.indexOf('id="url-error"')).toBeLessThan(html.indexOf('id="url-helper"'));
  });

  it("marks optional fields, never required ones", () => {
    const html = render(
      <Field label="Description" optional>
        <Textarea />
      </Field>,
    );
    expect(text(html)).toContain("Description (optional)");
    expect(html).not.toContain("*");
  });

  it("passes disabled and read-only to the control, and hides a label on request", () => {
    const html = render(
      <Field label="Search" hideLabel disabled readOnly>
        <Input />
      </Field>,
    );
    const [input] = tagsWith(html, "data-slot", "input");
    expect(input).toMatch(/\sdisabled=""/);
    expect(input).toMatch(/\sreadOnly=""|\sreadonly=""/);
    expect(html).toContain("sr-only");
  });

  it("grows a textarea from 3 rows and never shows a grabber", () => {
    const [area] = tagsWith(render(<Textarea />), "data-slot", "textarea");
    expect(attr(area, "rows")).toBe("3");
    expect(classes(area)).toEqual(expect.arrayContaining(["resize-none", "min-h-20", "max-h-55"]));
  });
});

describe("InlineAlert, Logo, Badge and StatusBadge", () => {
  it("InlineAlert draws each tone with its own icon, title first", () => {
    const icons = {
      info: "Info",
      success: "CheckCircle",
      warning: "Warning",
      danger: "WarningCircle",
      highlight: "Lightbulb",
    } as const;
    for (const [tone, icon] of Object.entries(icons)) {
      const html = render(
        <InlineAlert tone={tone as keyof typeof icons} title="Title">
          Body
        </InlineAlert>,
      );
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain(`fin-ico--${icon}`);
      expect(html.indexOf("Title")).toBeLessThan(html.indexOf("Body"));
    }
  });

  it("InlineAlert is dismissible only when asked", () => {
    expect(render(<InlineAlert tone="info" title="x" />)).not.toContain("Dismiss");
    expect(render(<InlineAlert tone="info" title="x" onDismiss={() => {}} />)).toContain(
      'aria-label="Dismiss"',
    );
  });

  it("Logo draws the lockup at 18 and the mark at 24, never below 16", () => {
    expect(render(<Logo />)).toContain('height="18"');
    expect(render(<Logo variant="mark" />)).toContain('height="24"');
    expect(render(<Logo variant="mark" height={10} />)).toContain('height="16"');
    expect(render(<Logo label="Fin home" />)).toContain('aria-label="Fin home"');
  });

  it("Badge is an outline fact by default, and has every category hue", () => {
    expect(
      classes(tagsWith(render(<Badge>Sample data</Badge>), "data-slot", "badge")[0]),
    ).toContain("border-border-strong");
    expect(badgeHues).toHaveLength(16);
    for (const hue of badgeHues) {
      expect(render(<Badge color={hue}>Tag</Badge>)).toContain(
        `bg-badge-${hue}-bg text-badge-${hue}-fg`,
      );
    }
  });

  it("StatusBadge says the status in words, as a badge or a dot", () => {
    const badge = render(<StatusBadge tone="danger">Rejected</StatusBadge>);
    expect(badge).toContain("bg-status-danger-bg");
    expect(text(badge)).toBe("Rejected");
    const dot = render(
      <StatusBadge tone="success" presentation="dot">
        Completed
      </StatusBadge>,
    );
    expect(dot).toContain('aria-hidden="true"');
    expect(text(dot)).toBe("Completed");
  });
});

describe("the Skeleton family", () => {
  it("every shape is hidden and marked for the shimmer", () => {
    for (const shape of ["text", "badge", "control", "circle", "block"] as const) {
      const html = render(<Skeleton shape={shape} />);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('data-skeleton=""');
      expect(html).toContain("bg-fill-selected");
    }
    expect(render(<SkeletonText lines={3} />).match(/data-skeleton/g)).toHaveLength(3);
  });

  it("a section or page is a busy region named Loading {label}", () => {
    for (const html of [
      render(<SkeletonSection label="beneficiaries" />),
      render(<SkeletonPage label="transactions" toolbar />),
    ]) {
      expect(html).toContain('aria-busy="true"');
      expect(html).toMatch(/aria-label="Loading (beneficiaries|transactions)"/);
    }
    expect(
      render(<SkeletonPage label="x" rows={2} toolbar />).match(/data-shape="control"/g),
    ).toHaveLength(3);
  });
});

describe("Avatar", () => {
  it("takes initials from the name, else the email's first letter", () => {
    expect(initials("Maya Rivera")).toBe("MR");
    expect(initials("Maya")).toBe("M");
    expect(initials("  Ana  María  López ")).toBe("AL");
    expect(initials("", "lena@example.org")).toBe("L");
    expect(initials(null, null)).toBe("");
  });

  it("is a circle for people and a rounded square for businesses, with a flag badge", () => {
    expect(render(<Avatar name="Maya Rivera" />)).toContain("rounded-full");
    expect(render(<Avatar name="Acme Remit" kind="business" />)).toContain("rounded-sm");
    expect(render(<Avatar name="Maya Rivera" country="us" size={40} />)).toContain(
      'data-cue="flag-us"',
    );
    expect(render(<Avatar name="Maya Rivera" country="ZZ" />)).not.toContain("data-cue");
  });
});

describe("CopyField", () => {
  it("truncates the middle and names the copy button after the label", () => {
    expect(middleTruncate("a1b2c3d4e5f6a7b8c9f0e")).toBe("a1b2c3…9f0e");
    expect(middleTruncate("short")).toBe("short");
    expect(lowerFirst("Transaction ID")).toBe("transaction ID");
    expect(lowerFirst("API key")).toBe("API key");
    const html = render(<CopyField label="Transaction ID" value="trf_7f3a9c21d4e8b6a0c1d2" />);
    expect(text(html)).toContain("trf_7f…c1d2");
    expect(html).toContain('aria-label="Copy transaction ID"');
    expect(html).toContain("trf_7f3a9c21d4e8b6a0c1d2");
  });

  it("masks a secret until it is shown", () => {
    const html = render(<CopyField label="Signing secret" variant="secret" value="whsec_abc123" />);
    expect(html).not.toContain(">whsec_abc123<");
    expect(html).toContain("Show signing secret");
  });
});

describe("Checkbox", () => {
  it("is labelled natively and describes its error", () => {
    const html = render(
      <Checkbox id="terms" label="I accept the terms" error="Accept the terms to continue." />,
    );
    expect(html).toContain('<label for="terms"');
    const [box] = tagsWith(html, "role", "checkbox");
    expect(attr(box, "aria-describedby")).toBe("terms-error");
    expect(attr(box, "aria-invalid")).toBe("true");
  });

  it("reports the indeterminate state for select-all", () => {
    const [box] = tagsWith(
      render(<Checkbox aria-label="Select all" checked="indeterminate" />),
      "role",
      "checkbox",
    );
    expect(attr(box, "aria-checked")).toBe("mixed");
  });
});
