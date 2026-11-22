// The signed-out frame (spec 06 §4.3): @fin/ui's AuthLayout, the logo at the top linking Home (no
// link on verify's hosted pages, which are not Fin's console), and the page's AuthCard. The sign-in
// family, NoAccess, ProtectAccount and verify's hosted pages render inside it.
import { AuthLayout } from "@fin/ui";
import type { ReactNode } from "react";
import { RouterLink } from "../router/RouterLink.tsx";
import { useFin } from "../runtime/runtime.tsx";

export function AuthFrame({ children }: { children: ReactNode }) {
  const { app } = useFin();
  return (
    <AuthLayout homeHref={app === "verify" ? null : "/"} linkAs={RouterLink}>
      {children}
    </AuthLayout>
  );
}
