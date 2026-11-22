// The Saturday route stubs (P0-G): each route exists with its frame, its sidebar item, its title and
// its permission, and draws only its page's name until its lane builds the board (spec 06 §7.1,
// §8). Nothing here calls the API or pretends to.
import { RouterLink } from "@fin/frame";
import { AuthCard, PageHeader } from "@fin/ui";

/** A signed-in page's header, inside AppFrame. */
export function AppPageStub({ title }: { title: string }) {
  return <PageHeader title={title} linkAs={RouterLink} />;
}

/** A signed-out page's card, inside AuthFrame, with only its title until the page is built. */
export function AuthPageStub({ title }: { title: string }) {
  return <AuthCard title={title}>{null}</AuthCard>;
}
