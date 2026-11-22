# @fin/ui: third-party notices

`@fin/ui` is Fin's own code, written for fin-next from the Fin design system's specifications and
the design canvases. Nothing in it is ported from the old product (the owner's no to UI-12):
`PORTED.md` lists no files. It builds on, and ships inside each app's bundle, the code below.

## UI SDK (`@ui-sdk/react`, `@ui-sdk/core` 0.1.0-beta.9), Apache License 2.0

Behaviour, focus, keyboard, dismissal, positioning and ARIA for every control come from the UI SDK,
installed from the registry at the catalog's exact version and imported only here.

```
Copyright 2026 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The full licence text ships with each package (`node_modules/@ui-sdk/*/LICENSE`); neither package
ships a NOTICE file.

## React and React DOM 19.3.1 (MIT)

Peer dependencies, installed by each app. Copyright (c) Meta Platforms, Inc. and affiliates.

## Artwork and fonts, through Fin's own packages

- Glyphs (Phosphor Icons 2.1.10, MIT), round flags (circle-flags 2.8.3, MIT), token and network
  logos (Web3 Icons 4.0.58, MIT) and Fin's reserved brand marks: `@fin/icons`, `NOTICE.md`.
- Inter and Fira Mono (SIL Open Font License 1.1): `@fin/tokens`, `fonts/OFL.txt`.

## Design values

Token values, type roles, sizes and motion timings are the Fin design system's, read from its team
export as values and specifications only; no component source from the export is copied.
