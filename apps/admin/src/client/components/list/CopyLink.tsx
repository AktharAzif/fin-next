// Fin Admin's shared list layout (spec 06 §7.2, S6-33): "Copy link", the list's address as it is
// filtered, so the person it is sent to opens the same list. The list says which address (with no
// page and no open record, so a copied link opens at the top).
import { CopyIcon } from "@fin/icons";
import { Button, toast } from "@fin/ui";

export function CopyLinkButton({ href }: { href: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      leadingIcon={<CopyIcon />}
      onClick={async () => {
        try {
          if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
            throw new Error("no clipboard");
          }
          await navigator.clipboard.writeText(href);
          toast.success({ title: "Link copied" });
        } catch {
          toast.error({
            title: "Couldn’t copy the link",
            description: "Copy it from the address bar instead.",
          });
        }
      }}
    >
      Copy link
    </Button>
  );
}
