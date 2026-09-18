---
name: dure-orchestration
description: Use Dure's durable interaction channel to receive Messages, answer Decisions, acknowledge Event cursors, and resume after reconnect. Use for Dure-dispatched work, durable human questions, checkpoints, and completion reports.
---

# Dure orchestration

Prefer the installed `dure-orchestration` MCP server. It uses the same versioned
client and canonical service as Dure desktop, CLI, SDK, and remote workers.

- Read new work from the durable Event cursor; never infer it from terminal text.
  A terminal wake is only a notification that the Event stream may have advanced.
- A Message is informational. A Decision blocks the exact dispatch generation
  until one Text or Select response is accepted.
- Reuse the operation idempotency key after an uncertain result. Do not invent a
  replacement generation, revision, participant, session, or capability.
- Acknowledge only through the last durably handled Event. Reconnect from the
  last acknowledged cursor.
- Report completion through the interaction service so dispatch state, the
  completion Message, and audit Event commit together.

## Completion reports

Write for someone who did not follow the work. Before any heading or list, open
with one short prose paragraph that identifies the product or project area and
prior problem in ordinary terms, states the user- or operator-visible outcome,
and explains why it matters. Use the recipient's language when it is known.
Never lead with an issue ID, commit SHA, test count, component name, protocol
term, or internal runtime detail; technical identifiers are evidence, not the
subject.

After the lead, include only useful detail in this order:

1. What changed and how to use it.
2. Important product choices or behavior that needs attention.
3. Verification, with source-labeled evidence such as the exact SHA, CI run,
   tests, and issue state.
4. Honest limitations, remaining risk, or `None observed`.
5. Prioritized next work when useful. For each item, state the benefit, concern,
   prerequisite, and likely conflict surface; do not invent follow-up work.

Keep the report self-contained: expand unfamiliar terms, explain
infrastructure-only effects on users or operators, and distinguish observed
facts from inferences. Later sections may carry complete technical detail, but
the opening paragraph must stand alone because compact clients may project it.

## Next-work Decisions

Only the user-facing coordinator completes its reporting Dispatch. Collaboration
subagents return recommendations to that coordinator and never open a competing
next-work Decision.

Completion alone does not query a task tracker or create a successor Dispatch.
When there is useful, current evidence for follow-up work, the coordinator may
pass `nextWorkCandidates` alongside `body` to `orchestration_dispatch_complete`.
Supply one to three recommendations in priority order, each with a unique `id`
(not `stop`) and nonempty `title`, `benefit`, `concern`, `prerequisite`, and
`conflictSurface` text. Omit the field to report completion only. Dure does not
require any particular tracker and does not claim the recommended work.

Explicit recommendations open one Select Decision on a successor reporting
Dispatch after completion commits. The two do not commit together: the
completion is sent first, and if the Decision cannot be opened the tool still
returns a successful completion receipt carrying
`nextWork = { state: "unavailable", code: "next_work_publication_failed" }`.
Read `nextWork.state` before concluding anything from an empty option list —
without it, supplying candidates and seeing success with no options looks
exactly like the user declining. The fix is to retry the same completion
request: the successor Decision is keyed by a hash of the completion target, so
a retry reuses that one Decision instead of opening a second.

Present the returned options in the current user conversation and commit the
user's choice with `orchestration_decision_answer`; the chat reply alone is not
the durable answer.
Before starting selected work, revalidate it against its authoritative source
and satisfy that project's prerequisites and coordination requirements. If it
is stale, publish one explanatory Message and open a refreshed Decision from
current evidence. If the user selects `stop`, do not claim or start more work.

If MCP discovery is unavailable, invoke the installed generic client contract;
do not type orchestration payloads into a PTY or provider conversation.

## Agent goals

`agent_goal_get` and `agent_goal_put` carry an explicitly requested Dure
goal. They are not part of the Dispatch lifecycle above: a goal is a standing
objective the backend continues across segments of the same conversation, and
it introduces no tracker and no mandatory next-work Decision. Touch them only
when the user asked for a goal.

```jsonc
// agent_goal_get
{ "body": { "schemaVersion": 1, "agentId": "…" } }

// agent_goal_put
{ "body": { "schemaVersion": 1, "agentId": "…", "expectedRevision": 0,
            "idempotencyKey": "…", "objective": "…",
            "status": "active", "detail": null } }
```

Read before writing. Carry the objective and the revision you just read into
`expectedRevision` — `0` only for a goal that does not exist yet — and keep
`idempotencyKey` (≤160 characters) stable across retries of the same intent.

A rejected revision means the direction changed under you. Re-read and
reconcile; resending the same body with a bumped number overwrites whatever the
user or another segment just decided.

`status` is `active` while useful work remains, `paused` for real waiting —
which stops future continuation without interrupting work already admitted —
and `complete` only after verifying the whole outcome, not the last step of it.

## If a tool named here is missing

This file installs with the integration, so it can be older or newer than the
MCP server actually serving this session. When a tool named above is not in the
server's list, that mismatch is the likely cause — do not fall back to typing
the payload into a terminal, and do not invent a neighbouring tool. Compare
`dure integration status --json` against the installed skill, and run
`dure integration update --global --approve-global-config` to bring the server,
its manifest and this file back to one version.
