# Design token evidence

[SOUL](design/SOUL.md) owns design intent. The implementation is
[src/index.css](src/index.css), [theme code](src/lib/theme/), and
[component source](src/components/). Read their tests for behavior.

This table is a machine input retained for the current coverage contract.
[token-scanner.ts](design/engine/token-scanner.ts) reads its token/value cells;
[judge.ts](design/engine/judge.ts) compares them with CSS values. Do not copy
component behavior, dimensions, or dated Figma measurements here. Evolve a token
and its checked evidence together. Runtime theme overrides remain owned by code.

Run `pnpm design:coverage:check` for source inventory, token checks, and
optional HTML mockup validation. `pnpm design:coverage --json` emits the versioned envelope; the
[CLI](design/engine/cli.ts), [mockup parser](design/engine/evidence.ts), and
[engine tests](design/engine/) own these contracts. Screen descriptions are not
verification inputs. Design decisions and measurement receipts belong in Issues.

| Role | Token | Light | Dark |
|---|---|---|---|
| App surface | `--background` | `#ffffff` | `#0a0a0a` |
| Sidebar surface | `--sidebar` | `#fafafa` | `#171717` |
| Sunken surface | `--surface-sunken` | `#fdfdfd` | `#171717` |
| Primary text | `--foreground` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` |
| Muted text | `--muted-foreground` | `oklch(0.523 0 0)` | `oklch(0.708 0 0)` |
| Usage popover muted text | `--usage-popover-muted` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` |
| Usage popover muted text utility | `--color-usage-popover-muted` | `var(--usage-popover-muted)` | same alias |
| Muted surface | `--muted` | `#f5f5f5` | `#262626` |
| Accent surface | `--accent` | `#f5f5f5` | `#404040` |
| Border | `--border` | `oklch(0 0 0 / 10%)` | `#ffffff1a` |
| Input | `--input` | `oklch(0 0 0 / 10%)` | `#ffffff26` |
| Settings dialog glass | `--glass-dialog` | `#ededf1` | `#424244` |
| Settings dialog glass utility | `--color-glass-dialog` | `var(--glass-dialog)` | same alias |
| Sheet edge cast | `--glass-shadow-sheet-edge` | `-4px 0 22px 0 #09090b24` | `-4px 0 22px 0 oklch(0 0 0 / 26%)` |
| Raised tray surface | `--glass-tray` | `#ffffff` | `#ffffff26` |
| Raised tray utility | `--color-glass-tray` | `var(--glass-tray)` | same alias |
| Terminal canvas paint | `--terminal-background` | `#ffffff` | `#242424` |
| Terminal canvas utility | `--color-terminal-background` | `var(--terminal-background)` | same alias |
| Pane header band | `--glass-header` | `#f1f1f1` | `#1a1a1a` |
| Card depth | `--glass-shadow-card` | `0 8px 18px -12px #09090b24, 0 1px 2px 0 #09090b14` | same definition |
| Card depth utility | `--shadow-card` | `var(--glass-shadow-card)` | same alias |
| Raised tray depth | `--glass-shadow-tray` | `0 1px 2px 0 #09090b12, inset 0 0 0 1px var(--glass-hairline)` | same definition |
| Raised tray depth utility | `--shadow-tray` | `var(--glass-shadow-tray)` | same alias |
| Shell tint alpha (light) | `--shell-tint-alpha-light` | `80%` | same value |
| Shell tint alpha (dark) | `--shell-tint-alpha-dark` | `50%` | same value |
| Shell tint alpha | `--shell-tint-alpha` | `var(--shell-tint-alpha-light)` | `var(--shell-tint-alpha-dark)` |
| Claude usage series | `--agent-claude-series` | `#d97757` | `#e08769` |
| Pane card outline | `--glass-card-outline` | `var(--glass-sheet)` | `var(--glass-sheet)` |
| Running | `--status-run` | `#15803d` | `#22c55e` |
| Attention | `--status-warn` | `#b45309` | `#f59e0b` |
| Blocked | `--status-blocked` | `#c2410c` | `#f97316` |
| Error | `--status-error` | `#b91c1c` | `#ef4444` |
| Done | `--status-done` | `#2563eb` | `#3b82f6` |
| Graph lane 0 | `--scm-lane-0` | `#64a6fc` | `#64a6fc` |
| Graph lane 1 | `--scm-lane-1` | `#a78bfa` | `#b78ff0` |
| Graph lane 2 | `--scm-lane-2` | `#fb8783` | `#fb7a76` |
| Graph lane 3 | `--scm-lane-3` | `#46d1d6` | `#00bfc6` |
| Graph lane 4 | `--scm-lane-4` | `#f8d356` | `#cb9d00` |
| Graph lane 5 | `--scm-lane-5` | `#99d464` | `#7db64a` |
| Graph lane 6 | `--scm-lane-6` | `#11b6e8` | `#00acdf` |
| Graph lane 7 | `--scm-lane-7` | `#26d8a0` | `#00c084` |
| Graph lane 8 | `--scm-lane-8` | `#ed86c7` | `#e87ec1` |
| Graph lane 9 | `--scm-lane-9` | `#f48252` | `#f68251` |
| Opaque alpha-mask stop | `--mask-opaque` | `#000` | Inherits root; no dark override |
| Search field text | `--text-field` | `0.8125rem` | — |
| Search field line height | `--text-field--line-height` | `1.125rem` | — |
| Inline badge text | `--text-2xs` | `0.6875rem` | same value |
| Inline badge line height | `--text-2xs--line-height` | `1rem` | same value |
| Card radius | `--glass-radius-pane` | `12px` | `12px` |
| Pane inner radius | `--glass-radius-pane-inner` | `0px` | `0px` |
| Loader stretch | `--dl-kx` | `1.45` | — |
| Loader cycle | `--dl-dur` | `2s` | — |
| Usage popover width | `--spacing-usage-popover-width` | `20.25rem` | — |
| Usage popover header | `--spacing-usage-popover-header` | `3.125rem` | — |
| Usage popover divider | `--spacing-usage-popover-divider` | `0.5625rem` | — |
| Usage popover limit | `--spacing-usage-popover-limit` | `2.5625rem` | — |
| Usage popover track | `--spacing-usage-popover-track` | `0.8125rem` | — |
| Usage popover empty notice | `--spacing-usage-popover-notice-empty` | `3.25rem` | — |
| Usage popover collected notice | `--spacing-usage-popover-notice-collected` | `4.75rem` | — |
| Usage popover radius | `--radius-usage-popover` | `0.875rem` | — |
| Surface opacity | `--surface-alpha` | `100%` | inherited |
| Pane surface | `--surface-pane` | `color-mix(in srgb, var(--glass-pane-tint, var(--glass-pane)) var(--surface-alpha), transparent)` | inherited |
| Header surface | `--surface-header` | `color-mix(in srgb, var(--glass-header-tint, var(--glass-header)) var(--surface-alpha), transparent)` | inherited |
| Sheet surface | `--surface-sheet` | `color-mix(in srgb, var(--glass-sheet-tint, var(--glass-sheet)) var(--surface-alpha), transparent)` | inherited |
| Background surface | `--surface-background` | `color-mix(in srgb, var(--background-tint, var(--background)) var(--surface-alpha), transparent)` | inherited |
| Terminal surface | `--surface-terminal` | `color-mix(in srgb, var(--terminal-background-tint, var(--terminal-background)) var(--surface-alpha), transparent)` | inherited |
| Pane surface utility | `--color-surface-pane` | `var(--surface-pane)` | same alias |
| Header surface utility | `--color-surface-header` | `var(--surface-header)` | same alias |
| Sheet surface utility | `--color-surface-sheet` | `var(--surface-sheet)` | same alias |
| Background surface utility | `--color-surface-background` | `var(--surface-background)` | same alias |
| Terminal surface utility | `--color-surface-terminal` | `var(--surface-terminal)` | same alias |
| Luminance-mask reveal | `--mask-luminance-reveal` | `#fff` | inherited |
| Luminance-mask conceal | `--mask-luminance-conceal` | `#000` | inherited |

## Component-scoped tokens

An explicit selector checks the last declaration on that exact unconditional CSS
selector. These base values apply in both modes; referenced semantic tokens own
any theme variation. Conditional and differently scoped declarations cannot
satisfy this table. A row must contain a value; naming a token alone is not evidence.
Luminance-mask colors above are structural white/black coverage, independent of
light/dark theme paint, just as the existing alpha-mask stop is structural.

| Role | Token | Base value | Dark override | Selector |
|---|---|---|---|---|
| Dockview transition | `--dv-transition-duration` | `70ms` | — | `.dockview-theme-abyss` |
| Drop target surface | `--dv-drag-over-background-color` | `var(--glass-tint-hover)` | — | `.dockview-theme-abyss` |
| Drop target border | `--dv-drag-over-border` | `1px solid color-mix(in srgb, var(--ring) 30%, transparent)` | — | `.dockview-theme-abyss` |
| Drop target border color | `--dv-drag-over-border-color` | `color-mix(in srgb, var(--ring) 30%, transparent)` | — | `.dockview-theme-abyss` |
| Floating pane radius | `--dv-border-radius` | `var(--glass-radius-pane)` | — | `.dockview-theme-abyss` |
| Floating pane shadow | `--dv-floating-box-shadow` | `var(--glass-shadow-dialog)` | — | `.dockview-theme-abyss` |
