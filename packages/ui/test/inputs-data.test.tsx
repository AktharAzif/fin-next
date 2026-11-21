// inputs/, data/ and auth/: OTPInput, Switch, DropdownMenu, ErrorState, the Table family and the
// signed-out layout.
import { describe, expect, it } from "vitest";
import {
  AuthCard,
  AuthFooter,
  AuthLayout,
  Button,
  DropdownMenu,
  ErrorState,
  formatMinor,
  MenuItem,
  OTPInput,
  otpSentence,
  Switch,
  Table,
  TableAmount,
  type TableColumn,
  TablePagination,
} from "../src/index.ts";
import { attr, render, tagsWith, text } from "./html.ts";

describe("OTPInput", () => {
  it("draws 6 boxes for authenticator codes and 8 for emailed ones, as one-time-code", () => {
    const six = render(<OTPInput label="Verification code" />);
    expect(six.match(/data-slot="otp-input-slot"/g)).toHaveLength(6);
    const [input] = tagsWith(six, "data-slot", "otp-input-control");
    expect(attr(input, "autoComplete") ?? attr(input, "autocomplete")).toBe("one-time-code");
    expect(attr(input, "inputMode") ?? attr(input, "inputmode")).toBe("numeric");
    expect(
      render(<OTPInput label="Emailed code" length={8} />).match(/data-slot="otp-input-slot"/g),
    ).toHaveLength(8);
  });

  it("is labelled, described by where the code went and by its status sentence", () => {
    const html = render(
      <OTPInput
        label="Verification code"
        description="We sent it to maya@example.com."
        status="invalid"
        attemptsLeft={2}
      />,
    );
    const [input] = tagsWith(html, "data-slot", "otp-input-control");
    const id = attr(input, "id") ?? "";
    expect(html).toContain(`<label for="${id}"`);
    expect(attr(input, "aria-describedby")).toBe(`${id}-description ${id}-status`);
    expect(attr(input, "aria-invalid")).toBe("true");
    expect(text(html)).toContain("That code isn’t right. Check it and try again. 2 attempts left.");
  });

  it("says each status in one sentence", () => {
    expect(otpSentence({})).toBeNull();
    expect(otpSentence({ status: "verifying" })).toBe("Checking the code…");
    expect(otpSentence({ status: "invalid", attemptsLeft: 1 })).toContain("1 attempt left.");
    expect(otpSentence({ status: "expired" })).toBe("This code expired. Send a new code.");
    expect(otpSentence({ status: "locked", lockedMessage: "Try again in 10 minutes." })).toBe(
      "Try again in 10 minutes.",
    );
    expect(otpSentence({ status: "success" })).toBe("Code accepted.");
  });

  it("is locked while verifying, and offers a resend with its cooldown", () => {
    const html = render(
      <OTPInput label="Code" status="verifying" onResend={() => {}} resendCooldown={30} />,
    );
    expect(tagsWith(html, "data-slot", "otp-input-control")[0]).toMatch(/\sdisabled=""/);
    expect(text(html)).toContain("Send a new code in 0:30");
    // The countdown is the resend control itself, disabled but focusable, so focus that was on it
    // stays on it while it sends and counts down.
    const resend = html.slice(html.indexOf('data-slot="fin-otp-resend"'));
    const [button] = tagsWith(resend, "type", "button");
    expect(attr(button, "aria-disabled")).toBe("true");
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(attr(button, "tabindex") ?? "0").toBe("0");
    expect(text(resend)).toContain("Send a new code in 0:30");
    expect(
      text(
        render(
          <OTPInput label="Code" onResend={() => {}} resendCooldown={30} initialCooldown={0} />,
        ),
      ),
    ).toContain("Didn’t get it? Send a new code");
  });
});

describe("Switch", () => {
  it("is a switch with a native label and its description", () => {
    const html = render(
      <Switch
        id="alerts"
        label="Email me when a payout fails"
        description="Sent to maya@example.com."
      />,
    );
    const [control] = tagsWith(html, "role", "switch");
    expect(html).toContain('<label for="alerts"');
    expect(attr(control, "aria-describedby")).toBe("alerts-description");
  });

  it("says busy while the change saves", () => {
    expect(
      attr(tagsWith(render(<Switch label="On" busy />), "role", "switch")[0], "aria-busy"),
    ).toBe("true");
  });
});

describe("DropdownMenu", () => {
  it("makes its trigger a menu button", () => {
    const html = render(
      <DropdownMenu trigger={<Button variant="secondary">Actions</Button>}>
        <MenuItem>Edit</MenuItem>
      </DropdownMenu>,
    );
    const [trigger] = tagsWith(html, "aria-haspopup", "menu");
    expect(attr(trigger, "aria-expanded")).toBe("false");
    expect(text(html)).toBe("Actions");
  });
});

describe("ErrorState", () => {
  it("says what failed, the default sentence, Try again and the request ID", () => {
    const html = render(
      <ErrorState title="Couldn’t load webhooks" onRetry={() => {}} requestId="req_01HZX4K9M2" />,
    );
    expect(text(html)).toContain("Couldn’t load webhooks");
    expect(text(html)).toContain("Check your connection and try again.");
    expect(text(html)).toContain("Try again");
    expect(html).toContain("req_01HZX4K9M2");
  });

  it("adds no live region of its own, in any size: it is spoken through announce()", () => {
    for (const size of ["section", "page", "inline"] as const) {
      const html = render(<ErrorState size={size} title="Couldn’t load webhooks" />);
      expect(html).not.toMatch(/role="(?:alert|status|log)"|aria-live/);
    }
  });

  it("uses the page's heading level when the header already has the h1", () => {
    expect(render(<ErrorState size="page" headingLevel={2} title="Couldn’t load Fin" />)).toContain(
      "<h2",
    );
    expect(render(<ErrorState size="page" title="Couldn’t load Fin" />)).toContain("<h1");
  });
});

type Row = { id: string; name: string; amount: number };
const rows: Row[] = [
  { id: "a", name: "Amara Okafor", amount: 1250000 },
  { id: "b", name: "Ben Adler", amount: 5 },
];
const columns: TableColumn<Row>[] = [
  { id: "name", header: "Name", sortable: true, cell: (r) => r.name },
  {
    id: "amount",
    header: "Amount",
    kind: "amount",
    cell: (r) => <TableAmount minor={r.amount} currency="USD" />,
  },
  { id: "actions", header: "Actions", kind: "actions", hideHeader: true, cell: () => null },
];
const base = {
  caption: "Customers",
  noun: { singular: "customer", plural: "customers" },
  columns,
  getRowId: (r: Row) => r.id,
  getRowLabel: (r: Row) => r.name,
  empty: <p>No customers yet</p>,
};

describe("Table", () => {
  it("is a native table with a caption, column headers and aria-sort on the sorted one", () => {
    const html = render(
      <Table
        {...base}
        rows={rows}
        sort={{ columnId: "name", direction: "ascending" }}
        onSortChange={() => {}}
      />,
    );
    expect(html).toContain('<caption class="sr-only">Customers</caption>');
    expect(tagsWith(html, "scope", "col")).toHaveLength(3);
    expect(attr(tagsWith(html, "aria-sort")[0], "aria-sort")).toBe("ascending");
    expect(html).toContain('<span class="sr-only">Actions</span>');
  });

  it("puts one row in the Tab order and makes rows real links", () => {
    const html = render(
      <Table {...base} rows={rows} onRowClick={() => {}} getRowHref={(r) => `?view=${r.id}`} />,
    );
    const rowTags = tagsWith(html, "data-row-id");
    expect(rowTags.map((t) => attr(t, "tabindex"))).toEqual(["0", "-1"]);
    expect(attr(rowTags[0], "aria-label")).toBe("Amara Okafor");
    expect(html).toContain('href="?view=a"');
  });

  it("marks the open row", () => {
    const html = render(<Table {...base} rows={rows} onRowClick={() => {}} activeRowId="b" />);
    expect(attr(tagsWith(html, "data-row-id", "b")[0], "data-active")).toBe("");
  });

  it("draws hidden skeleton rows while loading, busy", () => {
    const html = render(<Table {...base} rows={[]} status="loading" loadingRows={3} />);
    expect(html).toContain('aria-busy="true"');
    expect(tagsWith(html, "data-skeleton-row")).toHaveLength(3);
    const hiddenCells = tagsWith(html, "aria-hidden", "true").filter((t) => t.startsWith("<td"));
    expect(hiddenCells).toHaveLength(3 * columns.length);
  });

  it("says why it failed, keeping the header; shows the zero state for no rows", () => {
    const failed = render(
      <Table
        {...base}
        rows={[]}
        status="error"
        error={{ onRetry: () => {}, requestId: "req_9" }}
      />,
    );
    expect(text(failed)).toContain("Couldn’t load customers");
    expect(failed).toContain("<thead");
    expect(text(render(<Table {...base} rows={[]} />))).toContain("No customers yet");
  });

  it("keeps the rows while refreshing, and says so", () => {
    const html = render(<Table {...base} rows={rows} status="refreshing" />);
    expect(text(html)).toContain("Amara Okafor");
    expect(text(html)).toContain("Updating customers");
  });
});

describe("amounts and pagination", () => {
  it("formats minor units as major ones, exactly", () => {
    expect(formatMinor(1250000)).toBe("12,500.00");
    expect(formatMinor("123456789012345678")).toBe("1,234,567,890,123,456.78");
    expect(formatMinor(5n)).toBe("0.05");
    expect(formatMinor(-1999)).toBe("−19.99");
    expect(formatMinor(7, 0)).toBe("7");
    expect(() => formatMinor("1.5")).toThrow();
    expect(text(render(<TableAmount minor={1250000} currency="USD" />))).toBe("12,500.00 USD");
  });

  it("says where the page is, and which way it can go", () => {
    const html = render(
      <TablePagination
        page={1}
        pageCount={3}
        total={41}
        pageSize={20}
        onPageChange={() => {}}
        noun={{ singular: "member", plural: "members" }}
      />,
    );
    expect(text(html)).toContain("1–20 of 41 members");
    const previous = tagsWith(html, "aria-labelledby").length > 0 ? html : html;
    expect(previous).toContain("Previous page");
    expect(
      text(render(<TablePagination page={2} pageCount={5} onPageChange={() => {}} />)),
    ).toContain("Page 2 of 5");
  });
});

describe("AuthLayout and AuthCard", () => {
  it("links the logo home as Fin home, holds main, and centres one card that fades in", () => {
    const html = render(
      <AuthLayout footer={<AuthFooter>Help</AuthFooter>}>
        <AuthCard title="Sign in to Fin" description="New to Fin?">
          form
        </AuthCard>
      </AuthLayout>,
    );
    expect(html).toContain('aria-label="Fin home"');
    expect(html).toContain('href="/"');
    expect(html).toContain('<main id="main"');
    expect(html).toContain("fin-enter");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("<footer");
  });

  it("verify's pages can show the developer's name instead of Fin's logo, and no link", () => {
    const html = render(
      <AuthLayout homeHref={null} brand={<span>Acme Remit</span>}>
        x
      </AuthLayout>,
    );
    expect(html).not.toContain("Fin home");
    expect(text(html)).toContain("Acme Remit");
  });
});
