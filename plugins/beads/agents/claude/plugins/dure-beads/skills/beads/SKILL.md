---
name: beads
description: Use Beads for task tracking only when the user or repository explicitly selects Beads.
---

Beads is an optional integration. Installing Dure or making this skill available
does not select a tracker. Follow the user and repository tracker choice; do not
initialize Beads, migrate tasks, or require `bd` in repositories using GitHub
Issues, another tracker, or no tracker.

For explicitly selected Beads work, run `bd prime` and follow the closest
`AGENTS.md`. Use the repository-provided Beads collaboration wrapper when one
is declared. Keep implementation plans in Beads instead of ad hoc markdown
TODO files, and do not commit, push, or change shared tracker state without the
authority granted by the active repository and user instructions.

When claiming work, prefer the repository collaboration wrapper because it
should atomically attach the current Git branch as
`dure_worktree_branch` issue metadata. If no wrapper exists, resolve the exact
current branch with Git. On a symbolic branch, pass one `--set-metadata
dure_worktree_branch=<branch>` argument on the same `bd update --claim`
operation. In a detached worktree, pass `--unset-metadata
dure_worktree_branch` on that same operation so a previous binding cannot
survive and be guessed onto an agent pane.

Automatic Dure attribution is guaranteed only when the repository provides a
Dure collaboration wrapper that performs this resolution. A raw `bd update
--claim` uses Beads' own actor resolution, so do not assume it attributes the
claim to the current Dure agent.

Resolve claim attribution on every invocation in this order: a command-scoped
`BEADS_ACTOR`; the exact Dure session's canonical name plus stable identity ID;
then global Git `user.name` only when no Dure/Hmux agent marker exists. Absent
an explicit override, a marker must match one exact registry entry, the
cwd-owning worktree, and the exact branch; any marker/registry/cwd/branch
mismatch fails closed without a Git fallback. Remote SSH requires explicit
`BEADS_ACTOR` until typed identity transport exists. Never export or inject it
into a provider, terminal, pane, or long-lived process/session environment.
Attribution is not authentication or mutation authority. `show_agent_claims`
controls reads and display only, never actor selection, claim writes, or
authorization.

When recovering a retained wrapper journal, keep its validated original actor;
do not substitute the current pane or session identity.
