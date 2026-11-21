// The signed-out frame (spec 06 §4.3): one centred card carrying `.fin-enter`, the logo above it.
// The sign-in family, NoAccess, ProtectAccount and verify's hosted pages render inside it.
import { AuthLayout } from "@fin/ui/shell";
import type { ReactNode } from "react";

export function AuthFrame({ children }: { children: ReactNode }) {
  return <AuthLayout>{children}</AuthLayout>;
}
