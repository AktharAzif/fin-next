// Staff's two tabs (spec 02 S2-16, spec 06 §7.2): its members and their roles, so AdminRoles sits
// on the Staff page at `/staff/roles` rather than as a sidebar item. The first tab says "Members",
// so the page's tabs never repeat the sidebar's "Staff" link. Both need `staff.read`, which the
// routes ask for; the tabs show to whoever reaches either page.
import { RouterLink } from "@fin/frame";
import { TabLink, TabLinks } from "@fin/ui";

export function StaffTabs(props: { current: "staff" | "roles" }) {
  return (
    <TabLinks label="Staff" linkAs={RouterLink}>
      <TabLink href="/staff" current={props.current === "staff"}>
        Members
      </TabLink>
      <TabLink href="/staff/roles" current={props.current === "roles"}>
        Roles
      </TabLink>
    </TabLinks>
  );
}
