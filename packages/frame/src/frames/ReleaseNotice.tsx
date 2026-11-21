// "Fin was updated. Reload to get the latest version." (FW-C13, spec 06 §2.4): once per page, when
// an API answer names a release other than the one env.json named at load. Drawn in the frame's
// notice slot until @fin/ui's Toaster lands, which shows it as its one toast with Reload.
import { PageNotice } from "@fin/ui/shell";
import { useFin } from "../runtime/runtime.tsx";
import { useStore } from "../runtime/store.ts";

export function ReleaseNotice() {
  const fin = useFin();
  const release = useStore(fin.newRelease);
  if (release === null) return null;
  return (
    <PageNotice
      tone="info"
      title="Fin was updated."
      action={{ label: "Reload", onPress: () => window.location.reload() }}
    >
      Reload to get the latest version.
    </PageNotice>
  );
}
