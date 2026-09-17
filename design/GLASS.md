# Glass and focus intent

[SOUL](SOUL.md) owns design judgment. Current values and behavior live in
[desktop CSS](../src/index.css), [theme code](../src/lib/theme/),
[UI primitives](../src/components/ui/), and their consumers. [DESIGN](../DESIGN.md)
contains the token evidence read by the coverage engine; it is not a component
catalog. Historical canvases and measurements are references, not another
implementation authority.

## 1. Materials

Native desktop shell blur and window shadow belong to the OS;
[shell_corner.rs](../src-tauri/src/shell_corner.rs),
[window shape](../src/lib/workspace/window/windowShellShape.ts), and
[App](../src/App.tsx) own the implementation. Keep sidebar chrome transparent to
that material. Do not add CSS shell blur, a second outer shadow, or a black ring.
Fullscreen has no CSS shell corners or rim. A static canvas must approximate
native composition rather than copying its tint into a non-native surface.

Code/output panes and dialogs are opaque. Menus, tooltips, and popovers may use
subtle glass; scrims do not blur. Surface opacity does not prohibit translucent
hairlines. Keep glass-internal hairlines, menu hairlines, and structural borders
separate even when two theme values coincide.

## 2. Focus and selection

Use weight and foreground tone for active tabs and session rows, not a background
tint. The activity rail's tile is an exception; explicit multiselection is a
separate state. Do not dim unfocused work that users need to watch peripherally.
Pane focus uses a thin neutral outward stroke, caret, and title weight without
moving layout. A stronger colored exchange target must remain distinct from focus.
Only the header moves a pane; retain its identity glyph while dragging. Slot
numbers appear during the keyboard modifier gesture, not permanently.

## 3. Workspace

Treat the workspace deck as one clipped card. Gaps reveal its sheet; panes do not
gain individual card borders or shadows. Outer corners come from card clipping,
inner corners from pane geometry. A single full-card pane needs no focus ring.
The header band separates structure independently of focus, and its tone sits
below the body in both modes — chrome darker than content — and never equals
the sheet: equal to it in dark, neighbouring bands fused into one strip across
the gap (2026-09-09). Do not add a duplicate row of domain controls to pane
chrome.

## 4. Making a change

Reuse actual controls, tokens, and spacing classes. Use fixed heights and aligned
content for controls, allowing content-driven rows to grow. Do not reproduce a
control with improvised padding, patch an external design bundle, invent tokens,
or infer exact values from screenshots. When borrowing a reference, name the
layout/interaction idea and translate it into Dure's existing components and values.

Measure source/computed values, preserve settled sections, and verify affected
light/dark, focus, contrast, layout, and native-composition behavior. Label evidence
as observed, confirmed, or unverified. A failed measurement stays unverified.
New design decisions and remaining work belong in Issues; old measurements are
available in [Git history](https://github.com/hebbianai/dure-internal/tree/7e4edc7dabbe43cf7630ad793a8bef9f2b859ac6/design/reports).
