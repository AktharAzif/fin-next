// Verify's route stubs (P0-G): each link path exists in AuthFrame with its title, and draws only its
// card's heading until L-SUN-06 builds the hosted pages (spec 03; spec 06 §8.7). Nothing here calls
// the API.
import { AuthCard } from "@fin/ui";

export function AuthPageStub({ title }: { title: string }) {
  return <AuthCard title={title}>{null}</AuthCard>;
}
