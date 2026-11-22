// Fin Admin's shared list layout (spec 06 §7.2, S6-33), as the lists draw it: the filter chips
// and Clear filters, the quick views, the filter menus' triggers, Copy link, the results line and
// the cursor pager, and the drawer's stepper, with their accessible names and states. The audit
// log's journeys (e2e/sun/audit.spec.ts) drive them in the browser.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyLinkButton } from "./CopyLink.tsx";
import { CursorPager, totalLine } from "./CursorPager.tsx";
import { FilterChips } from "./FilterChips.tsx";
import { filterTrigger, Picked } from "./FilterMenu.tsx";
import { QuickViews } from "./QuickViews.tsx";
import { DrawerStepper } from "./SideDrawer.tsx";

const NOUN = { singular: "staff action", plural: "staff actions" };
const none = () => undefined;

/** The markup of the one element that holds `text`, from its opening tag. */
function elementWith(html: string, tag: string, text: string): string {
  const found = html.split(`<${tag}`).find((part) => part.includes(text));
  if (found === undefined) throw new Error(`no <${tag}> holds ${text}`);
  return found;
}

describe("the filter chips", () => {
  it("name each filter for its removal, offer Clear filters, and draw nothing with no filter", () => {
    const html = renderToStaticMarkup(
      <FilterChips
        chips={[
          { id: "action", label: "Action: Rejected a customer", onRemove: none },
          { id: "date", label: "Date: Today", onRemove: none },
        ]}
        onClear={none}
      />,
    );
    expect(html).toContain('aria-label="Remove filter: Action: Rejected a customer"');
    expect(html).toContain('aria-label="Remove filter: Date: Today"');
    expect(html).toContain("Clear filters");
    expect(renderToStaticMarkup(<FilterChips chips={[]} onClear={none} />)).toBe("");
  });
});

describe("the quick views", () => {
  it("press the chosen view, alone, in one group named Views", () => {
    const html = renderToStaticMarkup(
      <QuickViews
        views={[
          { value: undefined, label: "All" },
          { value: "mine", label: "My actions" },
        ]}
        value="mine"
        onChoose={none}
      />,
    );
    expect(html).toContain('<legend class="sr-only">Views</legend>');
    expect(elementWith(html, "button", "My actions")).toContain('aria-pressed="true"');
    expect(elementWith(html, "button", "All")).toContain('aria-pressed="false"');
  });
});

describe("the filter menus and Copy link", () => {
  it("say how many values a filter holds, and mark the chosen ones", () => {
    expect(renderToStaticMarkup(filterTrigger("Action", 0))).toContain(">Action<");
    expect(renderToStaticMarkup(filterTrigger("Action", 2))).toContain(">Action (2)<");
    expect(renderToStaticMarkup(<Picked on={false} />)).toBe(
      '<span aria-hidden="true" class="inline-block size-4"></span>',
    );
    expect(renderToStaticMarkup(<Picked on />)).toContain("<svg");
    expect(
      renderToStaticMarkup(<CopyLinkButton href="https://admin.example.com/audit" />),
    ).toContain("Copy link");
  });
});

describe("the results line and the cursor pager", () => {
  it("count the rows in words, up to the cap", () => {
    expect(totalLine(0, false, NOUN)).toBe("0 staff actions");
    expect(totalLine(1, false, NOUN)).toBe("1 staff action");
    expect(totalLine(12_345, false, NOUN)).toBe("12,345 staff actions");
    expect(totalLine(10_000, true, NOUN)).toBe("10,000 or more staff actions");
  });

  it("turn a way off when there is nothing that way", () => {
    const html = renderToStaticMarkup(
      <CursorPager
        total={8}
        capped={false}
        previous={null}
        next="aud_x"
        noun={NOUN}
        onPage={none}
      />,
    );
    expect(html).toContain('aria-label="Pagination"');
    expect(html).toContain("8 staff actions");
    expect(html.match(/<button[^>]*\sdisabled=""/g)).toHaveLength(1);
    const both = renderToStaticMarkup(
      <CursorPager total={8} capped={false} previous="a" next="b" noun={NOUN} onPage={none} />,
    );
    expect(both.match(/<button[^>]*\sdisabled=""/g)).toBeNull();
  });
});

describe("the drawer's stepper", () => {
  it("says where the open row sits, and why a way is off at either end", () => {
    const html = renderToStaticMarkup(
      <DrawerStepper step={{ index: 0, count: 8, onNext: none }} noun="staff action" />,
    );
    expect(html).toContain("1 of 8");
    expect(elementWith(html, "button", 'aria-label="Previous staff action"')).toContain(
      'aria-disabled="true"',
    );
    const last = renderToStaticMarkup(
      <DrawerStepper step={{ index: 7, count: 8, onPrevious: none }} noun="staff action" />,
    );
    expect(last).toContain("8 of 8");
    expect(elementWith(last, "button", 'aria-label="Next staff action"')).toContain(
      'aria-disabled="true"',
    );
  });
});
