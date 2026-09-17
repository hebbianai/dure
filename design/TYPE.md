# Dure type: mono or sans

Read this before choosing a font for a piece of text. It records one decision
the owner fixed on 2026-09-10 (source: the sidebar three-panel comp and Glass
IDE v7; sizes and weights in the glass spec §1-6 and §1-7). Implementations
are the authority for what ships; this page is the rule they follow.

## The rule

**If a person could copy the value and paste it somewhere, it is mono.
Otherwise it is sans.**

Mono is Geist Mono at weight 400, `muted-foreground` by default. Sans is
Geist at 400 or 500; 600 is reserved for one anchor title and one primary
action per screen. Both ship as variable faces from
`@fontsource-variable/geist`, and `src/index.css` is where the two families
are bound — this page named Inter until 2026-09-13, which was never what the
app loaded.

## Mono: values a machine produced

Identifiers and values the system emits, compared character by character,
never read aloud.

- Paths, addresses, URLs, repository paths (`~/dev/dure`, `origin/main`)
- Worktrees, branches, refs, commit hashes, versions (`v0.2.1`, `+3`)
- Counts and numeric meta standing alone (`12`, `3 sessions`) — as text, not
  in a badge
- Pairing codes, fingerprints, tokens
- Code, terminal output, diffs, the pane path bar
- Caps section eyebrows (`DURE · COLOR SPEC`)
- One-line empty states (`No sessions yet`)
- The sub line of a leaf row (the worktree and elapsed time under a session)
- Keyboard shortcuts
- Model IDs (`claude-sonnet-4`)

## Sans: words a person reads

Names, labels, sentences — anything read rather than compared.

- Session, file, folder and host names (leaf 13/400, container 13/500)
- Section and tab labels (`Recent files`, `Registered files`: 11/500, no icon)
- Buttons, menus, tooltips, dialog titles and bodies
- User message bubbles and agent prose
- Helper, error and explanatory text
- Titles and header labels (600 on static screens, 500 in working chrome)
- Agent names (Claude, Codex)

## Size is a slot, not a font

Mono does not mean 11px. The comp's desktop meta is 11/400 and its terminal
body is 12 at line-height 1.62, the pane path bar 10.5, and mobile pairing
codes 13 — the size belongs to the slot the text sits in. Components that
already ship a size keep it; the font and weight are what this rule decides
(owner call 2026-09-10, when the rule was applied to the existing screens).

## Edge cases

| Situation | Decision |
| --- | --- |
| File name | Sans. If a path is attached, only the path part is mono. A session row is a sans name over a mono sub line. |
| Numbers | Inside a sentence ("3 sessions running"), sans. Standing meta (a right-hand count, `2m ago`), mono. |
| Dates and relative times | In a meta slot, mono 11. Inside a sentence, sans. |
| 11px | A size, not a font. Section labels are sans 11/500; meta is mono 11/400 — weight separates them too. |
| Branches and refs | Mono everywhere, beside a title or in a badge slot included: no fill, mono text with an optional 1px `glass/hairline` ring. |
| Agent vs model | The name (Claude) sans; the ID (`claude-sonnet-4`) mono. |
| Shortcuts | Mono 11. |

## Do not

- Set mono at weight 500 or above.
- Set paths, hashes or versions in sans.
- Set file or session names in mono — a name is read.
- Make mono islands inside a sentence (inline code tokens excepted).
- Wrap mono meta in a filled badge (no fills on glass, see the glass charter).
