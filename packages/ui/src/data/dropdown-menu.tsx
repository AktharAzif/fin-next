// DropdownMenu, MenuItem, MenuRadioGroup and the rest (spec 06 §3.3; the export's DropdownMenu
// spec) on the SDK's menu: the WAI-ARIA menu pattern, typeahead, focus given back to the trigger.
// The menu draws its own popover chrome (the SDK resets that only for popovers and dialogs). A group
// label sits inside its group; `destructive` items are red; an item whose onSelect returns a
// Promise shows data-pending while it runs and keeps the menu open; one that throws is reported.
import { CheckIcon } from "@fin/icons";
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIndicator,
  MenuTrigger,
  MenuGroup as SdkMenuGroup,
  MenuItem as SdkMenuItem,
  MenuRadioGroup as SdkMenuRadioGroup,
  MenuRadioItem as SdkMenuRadioItem,
  MenuSeparator as SdkMenuSeparator,
} from "@ui-sdk/react/menu";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Spinner } from "../foundation/spinner.tsx";
import { cn } from "../lib/cn.ts";
import { ACTION_FAILED, runReported, useReportFailure } from "../lib/failures.tsx";
import { toast } from "../overlays/toaster.tsx";

export type DropdownMenuProps = {
  /** Usually an IconButton named for its object ("Actions for Amara Okafor"), or a Button. */
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Width and other chrome for the content (the account menu is 288px, the organisations 240px). */
  className?: string;
};

export function DropdownMenu(props: DropdownMenuProps) {
  return (
    <Menu
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.defaultOpen === undefined ? {} : { defaultOpen: props.defaultOpen })}
      {...(props.onOpenChange === undefined
        ? {}
        : { onOpenChange: (open: boolean) => props.onOpenChange?.(open) })}
    >
      <MenuTrigger render={props.trigger} />
      <MenuContent
        side={props.side ?? "bottom"}
        align={props.align ?? "start"}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          "m-0 flex min-w-48 max-h-available flex-col overflow-auto rounded-md border-0 bg-surface-raised p-1 text-text-primary shadow-popover",
          "origin-popup transition-popup state-starting:scale-pop state-starting:opacity-0",
          "state-ending:scale-pop state-ending:opacity-0 state-ending:duration-base-exit",
          props.className,
        )}
      >
        {props.children}
      </MenuContent>
    </Menu>
  );
}

const ITEM = cn(
  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body text-text-primary outline-none no-underline",
  "state-highlighted:bg-fill-hover data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
  "data-pending:cursor-progress",
);

type SdkItemProps = ComponentProps<typeof SdkMenuItem>;

export type MenuItemProps = Omit<SdkItemProps, "className" | "children" | "onSelect"> & {
  /** A 16px glyph before the text. */
  icon?: ReactNode;
  /** A line under the text, such as the person's role (UR-05). */
  caption?: ReactNode;
  /** Deletes data or cannot be undone. */
  destructive?: boolean;
  onSelect?: (event: Event) => unknown;
  /** Makes the item a link. */
  href?: string;
  reportIds?: Readonly<Record<string, string>>;
  className?: string;
  children: ReactNode;
};

function ItemBody(props: {
  icon?: ReactNode;
  caption?: ReactNode;
  children: ReactNode;
  pending?: boolean;
}) {
  return (
    <>
      {props.pending === true ? (
        <Spinner />
      ) : props.icon === undefined ? null : (
        <span className="inline-flex shrink-0 text-text-tertiary">{props.icon}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{props.children}</span>
        {props.caption === undefined ? null : (
          <span className="truncate text-caption text-text-secondary">{props.caption}</span>
        )}
      </span>
    </>
  );
}

export function MenuItem(props: MenuItemProps) {
  const { icon, caption, destructive, onSelect, href, reportIds, className, children, ...rest } =
    props;
  const report = useReportFailure();
  return (
    <SdkMenuItem
      {...rest}
      {...(destructive === true ? { destructive: true } : {})}
      {...(href === undefined
        ? {}
        : {
            // The item's text becomes the link's content: the SDK renders its children into it.
            // biome-ignore lint/a11y/useAnchorContent: the content is the item's children
            render: <a href={href} />,
          })}
      {...(onSelect === undefined
        ? {}
        : {
            onSelect: (event: Event) =>
              runReported(
                () => onSelect(event),
                report,
                reportIds ?? {},
                () => toast.error(ACTION_FAILED),
              ),
          })}
      className={cn(ITEM, destructive === true && "text-status-danger-fg", className)}
    >
      {(state: { pending?: boolean }) => (
        <ItemBody icon={icon} caption={caption} pending={state.pending === true}>
          {children}
        </ItemBody>
      )}
    </SdkMenuItem>
  );
}

/** Related items, with their label inside the group. */
export function MenuGroup(props: { label?: string; children: ReactNode }) {
  return (
    <SdkMenuGroup className="flex flex-col">
      {props.label === undefined ? null : (
        <MenuGroupLabel className="px-2 pt-1.5 pb-1 text-caption font-medium text-text-tertiary">
          {props.label}
        </MenuGroupLabel>
      )}
      {props.children}
    </SdkMenuGroup>
  );
}

export function MenuSeparator() {
  return <SdkMenuSeparator className="-mx-1 my-1 h-px bg-border" />;
}

type SdkRadioGroupProps = ComponentProps<typeof SdkMenuRadioGroup>;

export function MenuRadioGroup(
  props: Omit<SdkRadioGroupProps, "className" | "children"> & {
    label?: string;
    children: ReactNode;
  },
) {
  const { label, children, ...rest } = props;
  return (
    <SdkMenuRadioGroup {...rest} className="flex flex-col">
      {label === undefined ? null : (
        <MenuGroupLabel className="px-2 pt-1.5 pb-1 text-caption font-medium text-text-tertiary">
          {label}
        </MenuGroupLabel>
      )}
      {children}
    </SdkMenuRadioGroup>
  );
}

export function MenuRadioItem(props: {
  value: string;
  icon?: ReactNode;
  caption?: ReactNode;
  disabled?: boolean;
  closeOnSelect?: boolean;
  children: ReactNode;
}) {
  return (
    <SdkMenuRadioItem
      value={props.value}
      label={typeof props.children === "string" ? props.children : props.value}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      {...(props.closeOnSelect === undefined ? {} : { closeOnSelect: props.closeOnSelect })}
      className={ITEM}
    >
      <ItemBody icon={props.icon} caption={props.caption}>
        {props.children}
      </ItemBody>
      <MenuItemIndicator className="ml-auto inline-flex shrink-0">
        <CheckIcon />
      </MenuItemIndicator>
    </SdkMenuRadioItem>
  );
}
