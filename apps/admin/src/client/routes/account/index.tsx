// `/account` (AdminAccount, "Your sign-in"; spec 06 §7.2): any working staff session. The staff
// menu's "Your sign-in" opens it.
import { createFileRoute } from "@tanstack/react-router";
import { AccountPage, AccountSkeleton } from "../../account/AccountPage.tsx";
import { loadAccount } from "../../account/load.ts";

export const Route = createFileRoute("/account/")({
  staticData: { frame: "app", navId: null, pageName: "Your sign-in" },
  loader: ({ context }) => loadAccount(context.fin),
  pendingComponent: AccountSkeleton,
  component: AccountRoute,
});

function AccountRoute() {
  return <AccountPage data={Route.useLoaderData()} />;
}
