# @fin/ui

Fin's controls and surfaces on the UI SDK (spec 06 §3). Screens import controls only from here;
nothing else in the repository imports `@ui-sdk/*`. Built fresh from the Fin design system's
specifications and the design canvases (UI-12: no port).

| Folder | Holds |
|---|---|
| `src/foundation/` | Button, IconButton (with the 24px size), TextButton, Spinner, Tooltip, Field, Input, Textarea, InlineAlert, Logo, Badge, StatusBadge, the Skeleton family, Avatar, CopyField, Checkbox |
| `src/overlays/` | Modal, ConfirmDialog, SecretReveal, Toaster and `toast()`, Tabs and TabLinks, PageHeader, EmptyState and DocsLink |
| `src/inputs/` | OTPInput, Switch |
| `src/data/` | DropdownMenu and its items, ErrorState, Table, TableId, TableAmount, TablePagination |
| `src/auth/` | AuthLayout, AuthCard, AuthFooter |
| `src/lib/` | `cn`, `announce`, the failure reporter (`ReportFailures`); `qr/`: the QR encoder (ISO/IEC 18004, written fresh, imported with `QrCode`) and `QrCode`, which draws it as SVG rects on whole pixels (UR-13), exported as `@fin/ui/qr` |
| `src/shell/` | The shells lane's (AppShell, Sidebar, the header menus) |
| `src/kit.tsx` | Kit-only exports (the page-policy probes); never imported by a screen |
| `kit/` | The kit page: every component above, live, built in test mode only |
| `e2e/` | The kit spec: the kit under the production page policy on Chromium, Firefox and WebKit |

## Checks

```sh
pnpm --filter @fin/ui test        # unit tests: static markup, no DOM package
pnpm --filter @fin/ui e2e         # builds the kit (vite --mode test) and runs the kit spec
```

The kit spec needs the Playwright browsers once per machine:
`pnpm --filter @fin/ui exec playwright install chromium firefox webkit`. It serves `dist/kit`
through Playwright's routing with the policy of spec 06 §6.1, records every
`securitypolicyviolation` from an init script and fails on any, and never sets `bypassCSP`.
