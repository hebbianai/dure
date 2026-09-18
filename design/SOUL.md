# Dure design charter

Read this before making a design decision. This charter defines Dure's attention,
interaction and visual intent. It does not describe shipped behavior.
Implementations and tests are the authority for what works; open decisions
belong in GitHub Issues.

## 1. Attention and agency

Answer: what changed since my last review, what should I do next, and what
supports that recommendation? Session location and raw activity are details the
user can inspect. Even with five agents working, the next decision must be clear
without visiting every pane. Normal execution stays quiet.

People must be able to continue the work themselves, explore with an agent,
redirect it, or hand it back. Do not reduce their role to pressing approval
buttons. Human briefs and agent work packets present the same context to different
audiences. Explain provider, runtime, or local/SSH differences only where those
facts affect a choice.

## 2. Identity

Dure takes its name from the Korean tradition of shared village labor. The mark's
open ring of flowing, monochrome droplets suggests independent agents joining
one effort. Prefer rounded, fluid forms, parallel arrangements, and visible
connections. A Space is the shared workplace; panes are where work happens.
Reuse the existing vector mark rather than drawing a new interpretation.

## 3. Visual language

Use quiet editorial precision: achromatic surfaces, restrained type, deliberate
alignment, and whitespace that explains structure. Black is an anchor in light
mode, not a dominant slab. Soft blur and tonal gradients can express material;
dot patterns can express many small contributions. Avoid heavy card grids,
stacked borders/shadows, and decoration that competes with work.

Working UI spends color on intervention and danger. Rare, softly diffused,
low-saturation color belongs to expressive brand surfaces such as onboarding,
empty states, and marketing, not code or output. Avoid vivid bounded color blocks.

Dark mode translates the same hierarchy: use dark gray rather than pure-black
surface paint, reserve near-white for anchors, and express elevation through
slightly brighter surfaces. Tune functional and brand colors for comparable
perceived emphasis in each mode; do not mechanically invert the light palette.
Exact values and typography come from the source, not a second prose palette;
the one type decision kept in prose, mono or sans, is [TYPE.md](TYPE.md).

## 4. Glass

Code, terminal output, and diffs require opaque reading surfaces. An empty pane
may be expressive; once work appears, background interference must disappear.

Permanent desktop chrome uses the platform's native material. Temporary menus,
popovers, and tooltips may use subtle glass only while text stays readable;
dialogs and other reading/decision surfaces stay opaque. Never blur a scrim or
place blur over information the user must read. Expressive glass belongs only
where work is absent. When uncertain, choose the quieter material.

[GLASS](GLASS.md) records the remaining material and focus decisions and links
to implementation. A canvas approximation is never a runtime material value.

## 5. Reports, state, and continuity

- Show failures persistently and quietly at the failing pane, row, or control,
  with a cause and next action. Do not steal focus, blink, or create a toast for
  every failure. If other work is affected, project the same event into its
  decision/briefing view with the same source and generation.
- Running, idle, and completed work are visually quiet. Reserve one accent for
  human intervention and danger color for failure or destructive actions.
  Motion signals change and then stops. The sole ongoing exception is one line
  of text shimmer per pane while actual streaming/tool work continues; stop it
  on completion and use static text with reduced motion.
- A report explains change, significance, needed judgment, recommendation and
  options, remaining risk, and next action. Evidence is immediately available
  below it. Tool calls and heartbeats are inspectable records, not reports.
- Interrupt only for imminent irreversible/high-risk action. Time-bound choices
  belong in a decision queue, meaningful progress in a briefing, and routine
  execution in quiet records. Group reports without combining the authority
  for distinct destructive or external effects.
- Preserve goals, success conditions, constraints, decisions and reasons,
  rejected options, assumptions, evidence, open questions, and next actions.
  Show source, time, scope, and version. Invalidate only claims affected by a
  changed SHA, instruction, permission, task, or runtime generation; preserve
  the lineage of human goals and decisions.
- Reading a brief advances a reading checkpoint, not permission or task state.
  Direction changes distinguish decision, affected targets, delivery, confirmed
  new context, and application/replanning. Show partial application, conflicts,
  and unreachable targets; obsolete work must not cross its next permitted
  mutation boundary. Each active workstream needs a way to redirect or safely
  realign it.
- Checkpoints expose milestone, deviation, new assumptions, next action, and
  stop conditions. Keep agreed work moving; ask about changed feasibility or
  scope. Separate agent self-report from observed Git/runtime/test/policy facts.
  An exceeded reporting horizon means progress is unconfirmed even if a process
  is alive. Escalate a repeated event only when impact or risk changes.
- Briefings, decisions, and checkpoints are views of shared facts. Add a view
  only when it reduces pane patrol, repeated explanation, or manual handoff.
  At account selection, show the account, observed usage/reset, and stale or
  unknown state. Account switching must make its process/conversation effect
  understandable rather than hiding it behind a color change.

## 6. Predictable interaction

Reuse the same agent, diff, and Git symbols with the same meanings. Name controls
for their visible result and use user vocabulary, not protocol internals.
Prefer confirmation in the initiating row; use a dialog when the effect spans
surfaces or requires additional choices. Target WCAG 2.2 AA: keep keyboard access,
visible focus, and at least 4.5:1 body-text contrast.
Dragging, closing, reconnecting, and returning from focus mode must preserve the
user's expected place and context. Do not silently rearrange or reset the UI.

## 7. Voice

Use [WRITING](WRITING.md): plain, active, honest copy. Distinguish implemented
behavior from proposals. Empty states offer the next action; errors explain the
problem and remedy. Do not inflate claims or stage emotions.

## 8. Review

Check attention with several concurrent agents, evidence freshness, handoff and
partial failure, material/readability, color and motion, keyboard/focus, and
predictable outcomes. Reuse [existing components](../src/components/) and their
shadcn conventions before inventing UI. Source measurements and relevant behavior
checks support a change; a document's presence does not prove product behavior.
Keep new exceptions narrow, record the decision and reason in the owning Issue,
and encode stable enforceable rules in code/tests rather than another checklist.
