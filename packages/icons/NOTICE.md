# @fin/icons: notices

This package holds Fin's own brand marks, which no licence covers, and artwork from outside Fin,
each under its own licence. Keep these notices, and the licence files they point to, with any copy
of the files they cover.

## The Fin.com lockup and the F mark (reserved)

`src/brand-art.ts` (drawn by `FinLockup` and `FinMark`) holds Fin's own artwork, from the brand
guide's vectors. The repository's LICENSE reserves the name "Fin", its logo and its other brand
assets: they are not licensed for any use, and not for use outside Fin's products. Never recolour,
stretch, skew, outline, re-space or rebuild them.

## Artwork from outside Fin

Each licence is its own file in `licenses/`, byte for byte the licence file of the release the
artwork came from. `THIRD_PARTY.json` lists each file with its package, version, the upstream file
and that file's SHA-256, and `test/third-party.test.ts` fails when a copy drifts from it.

- **Phosphor Icons 2.1.10 (MIT)**: `licenses/phosphor-icons-react-2.1.10.LICENSE`. `src/glyphs.ts`
  holds the bold and fill path data of the glyphs Fin uses, unchanged from `@phosphor-icons/react`
  2.1.10, which Fin does not install (OD-5). The SWIFT globe in `src/cues.ts` is Phosphor's Globe
  in the bold weight. `GoogleMark` draws Phosphor's GoogleLogo glyph; Google is a trademark of
  Google LLC, shown only on "Continue with Google".
- **circle-flags 2.8.3 (MIT)**: `licenses/circle-flags-2.8.3.LICENSE.md`. `src/cues.ts`
  (`flagArt`) holds the round flags Fin uses (US, EU, MX, IN, BD, PK), unchanged except that sizes
  and classes are removed and ids are made unique per instance. Flags identify a country, a region
  or the rail that runs there; they are not decoration.
- **Web3 Icons 4.0.58 (MIT)**: `licenses/web3icons-core-4.0.58.LICENCE`. The `@web3icons/core`
  4.0.58 release ships no licence file, so this is the project's own `LICENCE` at the commit its
  release tag names. `src/cues.ts` (`tokenArt`, `networkArt`) holds the stablecoin logos (USDC,
  USDT, PYUSD) and the network logos (Polygon, Ethereum, Arbitrum One, Solana, Base) in the
  package's "background" style, unchanged except that sizes and classes are removed and ids are
  made unique per instance. The logos are trademarks of their owners (Circle, Tether, PayPal,
  Polygon Labs, the Ethereum Foundation, Offchain Labs, the Solana Foundation, Coinbase), used only
  to identify the asset or network beside its name, never to imply endorsement, and not altered in
  shape or colour.
