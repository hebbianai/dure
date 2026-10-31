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

## Choose a message destination

`interaction.open` uses the audience in its payload. Your current context's
coordinator grant addresses your own coordinator; it does not discover another
agent or the user-facing orchestrator.

To update your own coordinator, call `orchestration_context_get_current`, then
`orchestration_interaction_open`, which publishes the full v1 input schema.
Construct its arguments as below (JavaScript notation; pass the resulting
object). Generate `updateKey` and `updateId` once for this Message:

```js
const body = {
  schemaVersion: 1,
  idempotencyKey: updateKey,
  writeCapability: context.interactionCapability,
  expectedDispatchRevision: context.dispatchRevision,
  openedAtMs: Date.now(),
  interaction: {
    kind: "message",
    common: {
      id: updateId,
      target: context.target,
      author: context.participant,
      audience: { grants: [context.coordinatorGrant] },
      title: updateTitle,
      descriptionMarkdown: updateMarkdown,
    },
    purpose: "update",
  },
};
const argumentsForUpdate = { body };
```

The draft fields belong under `interaction.common`, not at the top level. A
blocking Decision uses `kind: "decision"` with `response` (`{ kind: "text",
minBytes, maxBytes }` or `{ kind: "select", options: [{ id, label }],
minSelections, maxSelections }`) and `replyCapability:
context.coordinatorReplyCapability` instead of `purpose`; it revises the
Dispatch, so refresh context before later writes. The CLI fallback is
`dure orchestration invoke interaction.open '<body-json>' --json`. An
`orchestration_request_invalid` rejection names each failing field path.

For a message to another managed Session, discover that exact destination with
`dure inspect ... --json`, then resolve
`dispatch.context.get.exact-session` with `{ "schemaVersion": 1, "session": ... }`.
Copy the complete Session generation (sessionId, workspaceId, providerId,
runnerPrincipal, runnerInstance, channelEpoch, hostInstanceId, terminalEpoch)
and the returned `endpointFence.endpointRef`.

Call `orchestration_message_open_exact_session` with this body, substituting
observed identities and a unique operation key:

```json
{
  "schemaVersion": 1,
  "session": {
    "sessionId": "observed-session", "workspaceId": "observed-workspace",
    "providerId": "claude", "runnerPrincipal": "observed-principal",
    "runnerInstance": "observed-instance", "channelEpoch": "observed-channel",
    "hostInstanceId": "observed-host", "terminalEpoch": "observed-terminal"
  },
  "expectedEndpointRef": "observed-endpoint",
  "idempotencyKey": "message-operation-key",
  "interactionId": "message-id",
  "title": "Review update",
  "descriptionMarkdown": "The requested review is ready.",
  "openedAtMs": 1
}
```

Use the current Unix time for openedAtMs. The CLI fallback method is
`interaction.message.open.exact-session`. Check the returned
`deliveries[].endpoint.sessionIdentity` against the destination and retain that
receipt. A generation conflict requires fresh discovery, never a guessed fence.

## Inspect message delivery

Use `orchestration_interaction_progress` with the same `body` as
`orchestration_interaction_get` to inspect one interaction without reading or
acknowledging its inbox. The fallback is
`dure orchestration invoke interaction.progress '<body-json>' --json`.
Use `schemaVersion: 1`, `authority`, `interactionId`, `participant`,
`readCapability`, and the worker's `endpointFence` when reading as that worker.
For your own sent message, use your author participant and the exact Dispatch's
`interactionCapability` as `readCapability`, without a worker fence. Keep these
capabilities private.

For example, both get and progress accept the following body when reading as
the author. Copy authority and author from the accepted interaction, and use
that interaction's Dispatch capability. For exact-session messages, this is the
destination context resolved above, not the sender's current context:

```json
{
  "schemaVersion": 1,
  "authority": { "workspaceId": "observed-workspace" },
  "interactionId": "message-id",
  "participant": "observed-author-participant",
  "readCapability": "private-dispatch-interaction-capability"
}
```

For a worker reader, use its context participant, its complete observed
endpointFence, and its context deliveryCapability as readCapability. This also
reads updates opened after completion; current backends also accept the worker's
interactionCapability there. Never put capabilities in logs or feedback reports.
The fence's `sessionIdentity` changes after every restart or account switch, so
do not copy it into scheduled prompts or notes. Through the MCP tools, omit it to
use this Session's current identity; a copied identity that is no longer current
is replaced with this Session's own current one and reported in the result. If a
read reports `hmux_session_exited`, the calling process belongs to a Session
generation that has ended (for example a background process that outlived a
restart): stop acting from it and continue in the Agent's current Session.

Do not repeat a get or progress read that returned
`orchestration_record_not_found`: an interaction commits with its Event, so the
same read cannot find it later. Check the participant, readCapability and
endpointFence instead.

The result separates acceptance, each delivery's queued/read/acknowledged state,
the wake receipt, and Dispatch completion. `observed` means an authenticated
durable inbox read; it does not prove comprehension. `acknowledged` means the
client handled its cursor, not that the task finished. A wait timeout establishes
neither read status nor message loss. Completion is for the exact Dispatch;
an update accepted after its completion is not new completed work.

Timestamps absent from older stored records are `null`. `workerEndpoint`
identifies the associated worker generation; `workerTurnCorrelation:
"not_recorded"` explicitly means the inbox has no provider turn mapping. Do not
infer one from whichever terminal turn is active. A wake effect is not a turn.

Follow each delivery's `guidance`:

- `await_inbox_read`, `await_acknowledgement`, `await_completion`: wait for that
  durable transition; do not duplicate the message.
- `resolve_exact_session_then_wait`: the message is already durable. For
  `hmux_agent_prompt_runtime_changed`, re-resolve the same Session and check its
  generation, then wait for its next inbox read. Do not retarget a replacement
  worker or create another interaction to force a wake.
- `inspect_before_retry`: the wake may have written. Inspect progress first;
  never infer failure from silence or repeat an uncertain terminal write.
- `dispatch_completed`: inspect the recorded completion, separately from the
  message's delivery state.

After a lost submission response, retry only the identical interaction payload
and idempotency key. Once a receipt is accepted, progress reads are the recovery
path; replaying the accepted operation does not force another wake. Older
backends report a missing `orchestration.interaction.progress_v1` capability;
keep the original receipt and use existing exact interaction/event inspection.

## Completion reports

Call `orchestration_context_get_current` first. Its structured `context` supplies
the identities, revision, fences and audience for
`orchestration_dispatch_complete`. The tool publishes the full v1 input schema.
Construct its arguments as below (JavaScript notation; pass the resulting object,
not the source text). Generate `completionKey` and `completionMessageId` once for
this report, and write `reportTitle` and `reportMarkdown` as described below:

```js
const body = {
  schemaVersion: 1,
  idempotencyKey: completionKey,
  messageId: completionMessageId,
  target: context.target,
  expectedDispatchRevision: context.dispatchRevision,
  completedBy: context.participant,
  endpointFence: context.endpointFence,
  audience: { grants: [context.coordinatorGrant] },
  completionCapability: context.completionCapability,
  title: reportTitle,
  resultMarkdown: reportMarkdown,
  completedAtMs: Date.now(),
};
const argumentsForCompletion = { body };
```

Copy the context values verbatim; never guess revisions or reconstruct private
capabilities. Completion uses `messageId`, `expectedDispatchRevision`,
`completedBy` and `resultMarkdown`, not the similarly named context or interaction
fields. Keep the body private. After an uncertain transport result, reuse the
exact body and idempotency key, including `completedAtMs`. A definite
`orchestration_request_invalid` rejection requires correcting the indicated
field against the schema; an unchanged retry cannot fix it. Only an accepted
completion receipt proves that the report was recorded.

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

## Track a sent message

Use `dure send <agent-or-session> --track "message" --json` for a durable inbox message.
Use `--workspace ID` with an exact Session ID. This requires an observable managed
Session and its orchestration context. The receipt contains `receiptPath`; keep that
private local file, which holds the exact read capability but no message text.

`dure wait --message <receiptPath> --json` waits for an authenticated inbox read.
Use `--until acknowledged` for cursor acknowledgement, or `--until turn_started`
for a supported native Codex wake turn. A wake turn does not prove inbox read,
comprehension, or task success. Use the existing exact `--task`, `--dispatch`, and
`--generation` wait for task completion. Do not resend after a timeout.

`dure inspect <session> --workspace ID --json` and `dure ls --json` expose optional
Host `agentRuntimeState.progress`: the last provider activity, tool/thinking phase,
and `progress_unconfirmed` after five quiet minutes of thinking. This is attention,
not an exit or failure. Old Hosts and unsupported providers omit this evidence.
Read/acknowledgement remains durable; native turn history is bounded to the latest
32 wake receipts in the current provider observation source and Host generation.
Neither this observation nor its absence authorizes interruption.

## Dispatch deadlines

Use `orchestration_dispatch_deadline_set` to set or clear a deadline for one exact
Dispatch. Resolve context first, then supply `body` with `schemaVersion: 1`,
`target: context.target`, `writeCapability: context.interactionCapability`,
`expectedDispatchRevision: context.dispatchRevision`, a unique `idempotencyKey`,
`dueAtMs` (absolute Unix milliseconds, or explicit `null` to clear), and
`changedAtMs` (current Unix milliseconds). Reuse the entire body after an
uncertain response. Setting a deadline revises the Dispatch; refresh context
before further writes or completion.

`orchestration_dispatch_deadline_get` accepts `schemaVersion: 1`, the exact
`target`, and `readCapability: context.interactionCapability`. It returns the
current deadline, revision, state and any committed `overdueEventCursor` without
acknowledging inbox events. CLI fallbacks are `dispatch.deadline.set` and
`dispatch.deadline.get` via `dure orchestration invoke`.

The backend checks every five seconds while running and catches up after
restart. Overdue incomplete work, including blocked Decisions, queues one
informational coordinator Message per setting. Existing GUI/inbox readers can
render it. Completion remains authoritative: overdue is neither failure nor
permission to interrupt. No urgent provider-turn delivery is implied. An older
backend refuses with missing `orchestration.dispatch.deadline_v1` capability.
