// The pairs the design system's export draws below WCAG 2.2 AA (4.5:1 for text, 3:1 for the
// focus ring and the borders of controls; spec 06 §9), as tokens.test.ts measures them from
// export-pin/tokens.json. Fin does not change export values (a change lands in the design system
// first, README), so the pairs are raised to the design system as one request, UR-21, and listed
// here word for word, with both colours and the ratio. The contrast test fails when a pair below
// its ratio is not listed, when a listed pair passes, and when a colour or a ratio changes: a new
// value is a new decision, never a silent one.
//
// Accepted for staging only, on 21 Nov 2026, under the owner's delegation (the pull request's
// Decisions). AC-UI-02 is not met while this list holds a pair: production needs the design
// system's answer to UR-21 and the owner's sign-off of whatever remains.
export const BELOW_RATIO: Record<"light" | "dark", readonly string[]> = {
  light: [
    // The borders of fields and checkboxes, at rest and hovered, and a switch's off track.
    "border-input #e5e5e5 on bg #ffffff: 1.25 < 3",
    "border-input #e5e5e5 on surface #fafafa: 1.20 < 3",
    "border-input #e5e5e5 on surface-raised #ffffff: 1.25 < 3",
    "border-input #e5e5e5 on surface-subtle #f5f5f5: 1.15 < 3",
    "border-input-hover #d4d4d4 on bg #ffffff: 1.48 < 3",
    "border-input-hover #d4d4d4 on surface #fafafa: 1.42 < 3",
    "border-input-hover #d4d4d4 on surface-raised #ffffff: 1.48 < 3",
    "border-input-hover #d4d4d4 on surface-subtle #f5f5f5: 1.35 < 3",
    "border-strong #d4d4d4 on bg #ffffff: 1.48 < 3",
    "border-strong #d4d4d4 on surface #fafafa: 1.42 < 3",
    "border-strong #d4d4d4 on surface-raised #ffffff: 1.48 < 3",
    "border-strong #d4d4d4 on surface-subtle #f5f5f5: 1.35 < 3",
    // The 1px ring that edges a button and a switch's thumb, at rest and hovered.
    "shadow-button ring rgb(0 0 0 / 0.1) on bg #ffffff: 1.25 < 3",
    "shadow-button ring rgb(0 0 0 / 0.1) on surface #fafafa: 1.25 < 3",
    "shadow-button ring rgb(0 0 0 / 0.1) on surface-raised #ffffff: 1.25 < 3",
    "shadow-button ring rgb(0 0 0 / 0.1) on surface-subtle #f5f5f5: 1.25 < 3",
    "shadow-button-hover ring rgb(0 0 0 / 0.14) on bg #ffffff: 1.38 < 3",
    "shadow-button-hover ring rgb(0 0 0 / 0.14) on surface #fafafa: 1.37 < 3",
    "shadow-button-hover ring rgb(0 0 0 / 0.14) on surface-raised #ffffff: 1.38 < 3",
    "shadow-button-hover ring rgb(0 0 0 / 0.14) on surface-subtle #f5f5f5: 1.37 < 3",
    // Tertiary text in a hovered or selected row.
    "text-tertiary #707070 on fill-hover rgb(0 0 0 / 0.04) over surface #fafafa: 4.34 < 4.5",
    "text-tertiary #707070 on fill-hover rgb(0 0 0 / 0.04) over surface-subtle #f5f5f5: 4.16 < 4.5",
    "text-tertiary #707070 on fill-selected rgb(0 0 0 / 0.07) over bg #ffffff: 4.23 < 4.5",
    "text-tertiary #707070 on fill-selected rgb(0 0 0 / 0.07) over surface #fafafa: 4.06 < 4.5",
    "text-tertiary #707070 on fill-selected rgb(0 0 0 / 0.07) over surface-raised #ffffff: 4.23 < 4.5",
    "text-tertiary #707070 on fill-selected rgb(0 0 0 / 0.07) over surface-subtle #f5f5f5: 3.88 < 4.5",
  ],
  dark: [
    // The borders of fields and checkboxes, at rest and hovered, and a switch's off track.
    "border-input #404040 on bg #0a0a0a: 1.90 < 3",
    "border-input #404040 on surface #171717: 1.72 < 3",
    "border-input #404040 on surface-raised #1c1c1c: 1.64 < 3",
    "border-input #404040 on surface-subtle #262626: 1.45 < 3",
    "border-input-hover #525252 on bg #0a0a0a: 2.53 < 3",
    "border-input-hover #525252 on surface #171717: 2.29 < 3",
    "border-input-hover #525252 on surface-raised #1c1c1c: 2.18 < 3",
    "border-input-hover #525252 on surface-subtle #262626: 1.93 < 3",
    "border-strong #404040 on bg #0a0a0a: 1.90 < 3",
    "border-strong #404040 on surface #171717: 1.72 < 3",
    "border-strong #404040 on surface-raised #1c1c1c: 1.64 < 3",
    "border-strong #404040 on surface-subtle #262626: 1.45 < 3",
    // The 1px ring that edges a button and a switch's thumb, at rest and hovered.
    "shadow-button ring rgb(255 255 255 / 0.12) on bg #0a0a0a: 1.33 < 3",
    "shadow-button ring rgb(255 255 255 / 0.12) on surface #171717: 1.41 < 3",
    "shadow-button ring rgb(255 255 255 / 0.12) on surface-raised #1c1c1c: 1.43 < 3",
    "shadow-button ring rgb(255 255 255 / 0.12) on surface-subtle #262626: 1.46 < 3",
    "shadow-button-hover ring rgb(255 255 255 / 0.17) on bg #0a0a0a: 1.58 < 3",
    "shadow-button-hover ring rgb(255 255 255 / 0.17) on surface #171717: 1.68 < 3",
    "shadow-button-hover ring rgb(255 255 255 / 0.17) on surface-raised #1c1c1c: 1.71 < 3",
    "shadow-button-hover ring rgb(255 255 255 / 0.17) on surface-subtle #262626: 1.73 < 3",
    // Status text in a selected row on the subtle surface.
    "status-danger-fg #ff6467 on fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 3.96 < 4.5",
    "status-info-fg #51a2ff on fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.34 < 4.5",
    // Badges in a hovered or selected row.
    "status-danger-fg #ff6467 on status-danger-bg rgb(130 24 26 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-raised #1c1c1c: 4.44 < 4.5",
    "status-danger-fg #ff6467 on status-danger-bg rgb(130 24 26 / 0.3) over fill-hover rgb(255 255 255 / 0.05) over surface-subtle #262626: 4.43 < 4.5",
    "status-danger-fg #ff6467 on status-danger-bg rgb(130 24 26 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.05 < 4.5",
    "status-info-fg #51a2ff on status-info-bg rgb(28 57 142 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.31 < 4.5",
    "badge-red-fg #ff6467 on badge-red-bg rgb(130 24 26 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-raised #1c1c1c: 4.44 < 4.5",
    "badge-red-fg #ff6467 on badge-red-bg rgb(130 24 26 / 0.3) over fill-hover rgb(255 255 255 / 0.05) over surface-subtle #262626: 4.43 < 4.5",
    "badge-red-fg #ff6467 on badge-red-bg rgb(130 24 26 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.05 < 4.5",
    "badge-blue-fg #51a2ff on badge-blue-bg rgb(28 57 142 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.31 < 4.5",
    "badge-purple-fg #c27aff on badge-purple-bg rgb(89 22 139 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.26 < 4.5",
    "badge-pink-fg #fb64b6 on badge-pink-bg rgb(134 16 67 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.25 < 4.5",
    "badge-indigo-fg #7c86ff on badge-indigo-bg rgb(49 44 133 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface #171717: 4.29 < 4.5",
    "badge-indigo-fg #7c86ff on badge-indigo-bg rgb(49 44 133 / 0.3) over fill-hover rgb(255 255 255 / 0.05) over surface-raised #1c1c1c: 4.48 < 4.5",
    "badge-indigo-fg #7c86ff on badge-indigo-bg rgb(49 44 133 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-raised #1c1c1c: 4.10 < 4.5",
    "badge-indigo-fg #7c86ff on badge-indigo-bg rgb(49 44 133 / 0.3) over fill-hover rgb(255 255 255 / 0.05) over surface-subtle #262626: 4.08 < 4.5",
    "badge-indigo-fg #7c86ff on badge-indigo-bg rgb(49 44 133 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 3.73 < 4.5",
    "badge-violet-fg #a684ff on badge-violet-bg rgb(77 23 154 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.18 < 4.5",
    "badge-rose-fg #ff637e on badge-rose-bg rgb(139 8 54 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface-subtle #262626: 4.17 < 4.5",
  ],
};
