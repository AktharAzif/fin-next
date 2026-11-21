# UI requests

The live list of what the code needs from the Fin design system, or where it differs from it
(spec 06 §11.4, S6-29). One row per request: the board that needs it, the code that holds the
composition until the design system has it, and its state. Code that holds a pending composition
carries a `@pendingDesign UR-nn` comment.

| UR | Request | Board | Code | State |
|---|---|---|---|---|
| UR-01 | The sidebar's edge toggle | AppFrame, Sidebar | The shells lane (`src/shell/`), on `IconButton size="xs"` | Drawn on the canvases; shell code pending |
| UR-02 | IconButton's 24px size | AppFrame (edge toggle) | `src/foundation/button.tsx`: `IconButton size="xs"` (`size-target-min`), checked 24 by 24 in the kit spec | Built; the export has sm, md, lg only |
| UR-04 | The 24px rail mark (the export says 20px) | AppFrame, Sidebar | `src/foundation/logo.tsx`: the mark defaults to 24 | Built |
| UR-05 | A menu row caption (the role under each organisation) | AppFrame (organisation switcher) | `src/data/dropdown-menu.tsx`: `MenuItem` and `MenuRadioItem` take `caption` | Built |
| UR-07 | AccountMenu's role caption and "Account security" | AppFrame | `MenuItem caption`; the menu itself is the shells lane's | Partly built |
| UR-09 | The motion layer (page entrances, hover motion, the shimmer) | Motion, every board | `@fin/motion`: `fin-motion.css`, `Enter`, `Swap`, `NavigationBar` | Built (Fin's own file, pinned in `PIN.json`) |
| UR-10 | The navigation progress bar | AppFrame | `@fin/motion`: `NavigationBar` | Built; the frame places it |
| UR-13 | The authenticator's QR code as SVG, with the key for manual entry kept | Authenticator (scan, qrLoading, qrFailed), AccountSecurity (set-up dialog) | `src/lib/qr/` (imported as `@fin/ui/qr`): the encoder (fetched on demand) and `QrCode`, the board's 148px light tile of SVG rects; the console's `AuthenticatorScan` draws it beside the key | Built |
| UR-20 | Motion for glyphs outside the layer (Power, and any glyph a lane adds) | Fin Admin's sidebar | `@fin/icons` has the glyphs; `fin-motion.css` lists Power as still | Open |

Not yet raised by this package: UR-03, UR-06, UR-08, UR-11, UR-12 and UR-14 to UR-19 belong to the
shells, frame and screen lanes, which add their rows here when they build those parts.
