# dure — multi-agent coordination

You are an agent running inside Dure. The `dure` CLI lets you talk to
the other agents, each running in its own session and worktree. Run it with the
Bash tool. Inside your session your own identity is detected automatically.
`hebbian-ade` and `hebbian-ide` are deprecated compatibility aliases; use `dure` in new commands.

There is no `--from`/`--to` addressing here. `--to` belongs to
`dure hmux convert` alone, and `--from` is parsed but read by nothing. The
shared parser still swallows them: `dure send --to worker "run the tests"` eats
`--to worker`, takes the message itself as the recipient, and fails with
`Agent 'run the tests' was not found` — naming neither the flag nor the cause.
Always name the recipient as the first positional argument.

## Browser tasks

For website inspection and interaction in Dure, read `dure skills get dure-browser`
and use `dure browser` first, even when the user only says to open or check a URL.
Inspect existing tabs and panes before creating a Browser; preserve the user's
shared session and control. Playwright remains appropriate for isolated test
suites, an explicit request for it, or a required capability Dure lacks. The
Browser guide owns discovery, recovery, and returning control to the pane.

## Check who's around

```sh
dure ls                      # canonical Sessions + exact liveness
dure ls --backend devbox --json
```

`ls` queries the selected backend's `sessions.list` authority. A connected
client may add presentation labels for an exact generation, but `agents.json`
is never the Session inventory or liveness source.

## Stop and clean up an agent

```sh
dure stop project/worker --yes --json
dure stop <agent-id> --yes --json
```

This stops the selected Agent through its owning runtime, then removes its
registration and panes. Workspaces, worktrees and conversation history are
preserved. Use the exact Agent ID for retries or `project/name` when names repeat.
The selected Dure app must be running; its `DURE_APP_CHANNEL` chooses the client.
The app routes each Agent to its own backend. `--backend` is not accepted here.
`dure hmux stop --name ... --yes --json` uses the same path, including for Agents
created by `dure run`. Do not inject `/exit` or kill a PID to bypass `dispatch.stop`.
Read `dure stop --help` for options. Exit 0 with `ok: true` confirms cleanup;
after an uncertain response, retry the same Agent ID to reconcile the saved stop.
Stopping an Agent does not submit a completion report for its assigned work.

## Start another agent

```sh
# Uses the project containing the current directory.
dure run "implement user authentication"

# Select exactly one project by stable ID or backend-local absolute path.
dure run --project project-id --provider codex "implement feature X"
dure run --path /workspace/project "run the full test suite"

# Open in one connected-client Space. ID is preferred; an exact unique name
# is also accepted.
dure run --space Build "investigate the failing test"

# A fresh backend has no implicit client registry. Register the repository once;
# --path defaults to the current directory and --name defaults to the stable ID.
dure projects register project-id
dure projects register project-id --path /workspace/project --name "Project"
```

`--project` and `--path` are mutually exclusive. The CLI previews and then
applies one durable backend plan, so retries reuse the same operation instead
of creating a second agent.

Pane placement is a separate client-only result. Inside an exact Hmux pane,
omitting `--space` opens the new Agent in the same Space. The client prefers
splitting the invoking pane right or below, targeting at least 480×300 px per
pane. If neither split fits, it chooses another fitting pane. A full Space uses
the best available split; this does not create another Space or rearrange the
existing layout. Explicit split directions and drop positions are respected.
Outside a provable pane, the Run remains headless. If that exact Session
is visible in multiple Spaces, specify `--space`; Dure will not guess. A pane
failure never replays or stops a successful Run. Use `dure runs open <agent-id>
--space <space-id>` after correcting client state.

Bare `dure spawn` is a deprecated compatibility entry point to the same path;
`spawn preview`, `spawn apply`, and `spawn status` remain the low-level durable
service commands. Legacy option-style calls that relied on an implicit
dedicated worktree must pass `--no-worktree` for current project-root behavior;
Dure does not silently change worktree ownership.

Use the compatibility-only reuse action when an existing pane must follow its
durable managed rehost successor:

```sh
dure spawn --reuse --project Project --name agent-name --agent codex \
  --prompt "continue" --idempotency-key reuse-agent-1
```

This action requires a running Dure client. It reuses one exact existing Agent
or its durable successor and never falls back to a new Agent/provider launch.
Missing, ambiguous, incomplete, or changed lifecycle evidence fails closed.

## Choose a Run account

A current connected app supplies the selected account for the requested provider,
including headless Runs. Use `dure run --account ACCOUNT_ID ...` to pin an exact
app account, or `--account default` for the provider default. A CLI without a
connected app supporting account selection uses the provider default when the
option is omitted; an explicit unavailable account fails before launch.
The Run receipt's `plan.request.executionProfile` records the non-secret account
reference and credential generation. Human output includes `account`; `dure ls`
shows the account from a current client projection, or `unknown` when unavailable.

## Find and recover an existing Run

`dure ls` observes Sessions. `dure runs list --json` reads durable Run records,
including headless Runs after an app restart. Follow `nextCursor` with `--cursor`
until null, keeping the same backend. `launchState` records the original launch;
it does not prove that a process is still running.

```sh
dure runs show worker --json
dure runs open worker --space desk-id --json
dure runs resume worker --json                 # preview only
dure runs resume worker --confirm-restart --json
```

Use the exact Agent or operation ID when names are ambiguous. `open` places the
current existing runtime without launching another provider. `resume` uses the
local native recovery broker when an exact source conversation is recoverable,
retaining the conversation and publishing the new binding. A retained Run record
alone does not prove reboot recovery is possible. Keep its exact status/retry/publish commands if a response is uncertain;
repeating a name-based resume proposes another operation. Then use `open` to
place the recovered Run. Remote resume requires execution on its host.
For headless input/output, use the Session/workspace pair from `show` with
`read` and local `send`; an Agent name requires client registration. Direct Session
input verifies the current Host generation without requiring an app registry.
It does not support `--backend`, `--window-label`, or broker idempotency keys.
For a lookup failure, check the selected channel with `dure diagnostics --json`.

## Schedule durable runs

```sh
# The selected detached backend owns the Schedule and every Occurrence.
dure schedule create --cron "0 9 * * 1-5" --timezone Asia/Seoul \
  --project project-id --provider codex -- "triage ready work"

dure schedule list --backend devbox --json
dure schedule show <schedule-id> --backend devbox --json
dure schedule runs [schedule-id] --backend devbox --json
dure schedule delete <schedule-id> --expected-revision <revision> \
  --idempotency-key <stable-key> --backend devbox --json
```

With no `--project` or `--path`, the backend resolves the current directory.
Schedules survive app and client disconnects; they invoke the same durable
Run saga as `dure run` and never require a WebView timer. Reuse mutation
idempotency keys after uncertain responses and use the exact observed revision
for deletion. The retired `auto` command and automation JSON files are not
an authority or fallback.

When `dure` or the app runtime appears stale, collect the bounded one-shot
receipt before restarting anything:

```sh
dure version
dure diagnostics --json
dure diagnostics --check --require app,hmux,path
```

`diagnostics` reports CLI path shadowing, app descriptor liveness,
frontend/backend compatibility, and Hmux capability without exposing bearer
tokens or terminal content. It does not poll in the background.
`--check` is the opt-in automation contract: it grafts one `check` object onto
the same receipt — read `.check.required`, `.check.failed` and `.check.passed`,
not the top level — then exits non-zero when a selected runtime requirement is
not current. Without `--check`, degraded diagnostics still exit zero.

## Connected-client Space and pane control

Create a Space and select it through the connected app:

```sh
dure client space create --name "Review" --json
dure client space create --json
dure client space show <space-id> --json
```

Omitting `--name` uses the app's next default name. Creation returns
`space.spaceId` after the new Space mounts; use that ID for `space show` or
`pane create --space-id`. The MCP equivalent is `app_space_create` with an
optional `name`. If the response is uncertain, inspect `client observe` /
`app_observe` before creating again.

Pane placement belongs to a connected Dure client, not to Hmux or the detached
control plane. Use the explicit client surface when a script needs the same
split or close transaction as the app:

```sh
dure client pane split <reference-session-id> \
  --reference-panel-id <pane-id> --direction right
dure client pane close <pane-id> --space-id <space-id> --yes
dure client workspace open <pane-id> --space-id <space-id> --target cursor
dure client project add /repo --space <space-id-or-name>
dure client host add ec2-106 --json
dure client host add --hostname example.com --user ec2-user --identity-file ~/.ssh/key.pem --json
```

Mobile simulator workflows use the same pane UI and native device owner:

```sh
dure client pane open mobile --space-id SPACE --json
dure client pane state PANE --json
dure client pane act PANE mobile.devices --json
dure client pane act PANE mobile.select --args-json '{"platform":"ios","deviceId":"EXACT_ID"}' --json
```

Discover parameters with `pane state`. Use `mobile.profile.save` then
`mobile.run`, and `mobile.preview` with mode `live` for iOS input. Poll
`mobile.status` for `busy: false`, errors and `preview.liveFrameReady` before
input; `pending` is not completion. `mobile.boot` and `mobile.install` also return
`pending` immediately and use the same operation status.

Give each new status observation a fresh idempotency key; reusing a key replays
the original observation. After an uncertain mutation response, retain its key.
Only an explicit `error.execution: "not_started"` refusal confirms that the
handler did not run. For `pane_not_found`, reopen the existing pane, confirm its
identity and actions with `pane state`, then retry with a new key. The original
key retains its refusal. Do not change keys for pending or uncertain operations.

`mobile.key` sends `enter`, `tab` or `escape` to the exact selected Android
device through the same operation owner; iOS is currently unsupported. Enter
submits a focused field when its app/IME handles that key. Protected screenshots
remain protected.

If a mobile pane is hidden, use `dure client space show <exact-space-id>` or
`app_space_show` with its observed `spaceId`, then enable `mobile.preview` and
wait for `liveFrameReady` before iOS input. Discover identities with
`dure client observe` / `app_observe`; do not guess a Space number. Showing the
Space reuses its pane and selected device without restarting either, and does
not bring the Dure window to the OS foreground.

`mobile.tap`, `mobile.swipe`, `mobile.type` and the other named actions accept plain arguments
without nested action JSON. Observe the screenshot before targeting guest dialogs.
Touch uses normalized coordinates (0..1) plus the width/height returned by
`mobile.capture`; a capture from the previous orientation cannot authorize input.
For iOS, `mobile.rotate` also sets the pane's viewing angle, retained across
preview reconnects. External Simulator.app rotations do not change this view;
set portrait/landscape through the pane before continuing its workflow.
Every device operation requires the exact platform/device ID. Android uses
`auto` preview. For evidence, `mobile.report.prepare` returns a reviewable text,
screenshot path and report ID; `mobile.report.agents` lists recipients.
`mobile.report.draft` requires that report ID and an explicitly authorized
recipient, accepts edited/redacted text, and never submits the draft.

`project add` registers a shared working location in the connected app and
creates no pane, session or worktree; it is the client-side counterpart of the
backend-only `dure projects register` above, and neither substitutes for the
other. `split` creates the pane through the app's existing correlated
transaction.

`host add` imports an SSH config alias or registers explicit connection fields
through the same durable Host transaction as the GUI. It creates no session and
returns the canonical `registration.host.id` for `client pane create --host ID`.
Repeated identical key/automatic registrations reuse the saved Host. The first
terminal creation provisions a missing remote Hmux before requesting a session;
installation errors are returned without creating a pane.
`close` requires the exact Space and pane identity plus explicit confirmation;
it never selects a pane by focus or display name. `workspace open` resolves that
same exact pane generation and opens its local project or Agent worktree through
the app's native target catalog. It never falls back to a base repository or a
different editor. Omit `--target` only after a target has completed successfully
and become the client preference. All commands return typed JSON with `--json`.
If no Dure client is connected, they fail with `client_unavailable` without
treating `agents.json` as an authority.

## Durable orchestration

For dispatched work, use the separately installed `dure-orchestration` skill
and MCP server. That shared package is the protocol/discovery authority; this
general Dure skill does not duplicate its Message, Decision, cursor, or
completion contract.

- Read work with `orchestration_events_read` from the last acknowledged cursor.
- Use `orchestration_interaction_get` for the exact service-owned card.
- Open a Message or Decision with `orchestration_interaction_open`.
- Answer a Decision with `orchestration_decision_answer`.
- Finish only through `orchestration_dispatch_complete`, so state, completion
  Message, and audit Event commit together.
- Reuse the same idempotency key and exact generation/session capability after
  an uncertain response.
- Never deliver or answer orchestration by typing into a terminal.

The old `orch` file-mailbox subcommands — `send`, `inbox`, `check`, `ask`,
`task`, `gate`, `dispatch`, `reset` — are retired and fail without reading or
writing `~/.dure/orchestration.json`. For raw protocol debugging only,
`dure orchestration invoke <method> '<body-json>' [--backend ID] --json`
calls the same local, SSH, or hosted authority.

After Resume, use `orchestration_context_get_current` to resolve the current
managed Session. `orchestration_session_unavailable` with `retry_same` means the
backend could not obtain a valid live observation; it does not prove the
Session generation is stale. Retry the same lookup after a timeout or temporary
connection failure. For `hmux_runtime_identity_changed`, restart the Dure app
that owns the backend and reconnect the tools before retrying. For malformed
or inconsistent observations, run `dure diagnostics --json` and include the
`reasonCode` in feedback if the failure persists. Keep Dispatch identity and
cursor checkpoints; do not reset them or create another Run to bypass a refusal.
Actual generation mismatches retain `stale_generation` (or `terminal` for an
exact-session operation) and require resolving the current session again.

## Delegated workflows are not orchestration Dispatches

```sh
dure workflow done --task <id> --dispatch <id> --generation <n> [--result <text>] [--json]
dure workflow show --task <id> --dispatch <id> --generation <n> [--backend ID] [--json]
```

**Do not reach for this to finish a Dispatch.** Despite the shared
task/dispatch/generation vocabulary it is a different construct on a different
protocol method: `workflow.delegate_once.complete`, not the `dispatch.complete`
behind `orchestration_dispatch_complete`. An orchestration Dispatch still ends
only through the MCP tool above.

`done` completes the delegate-once workflow assigned to **this** managed Hmux
worker Session: it reads the session's own `HMUX_SESSION_ID`,
`HMUX_WORKSPACE_ID`, `HMUX_RUNNER_PRINCIPAL`, `HMUX_RUNNER_INSTANCE`,
`HMUX_CHANNEL_EPOCH`, `HMUX_HOST_INSTANCE_ID` and `HMUX_TERMINAL_EPOCH`, then
verifies the live Session still matches that exact generation. So it only works
from inside the worker, it requires the managed local backend, and it rejects
`--backend`. `--result` records up to 16 KiB in the same canonical receipt.

`show` reads an existing receipt without inferring Session state — it takes
`--backend` and rejects `--result`, so it is the safe way to ask "did that
already complete?" from anywhere. Both exit 2 on failure, printing
`error.code: error.message` (or that pair as JSON with `--json`).

Whoever delegated the work waits with `dure wait --task … --dispatch …
--generation …`; see the `dure-cli` skill.

## Reading another agent's screen

Local JSON reads preserve Hmux's `sessionName`, which is `null` for unnamed
managed sessions. Use `ok`, `lines` and `sequenceThrough` to inspect the result;
the app's Agent display name is not the runtime session name.

```sh
dure read <name>             # snapshot of their terminal
dure read <name> --json      # snapshot with lines[] and sequenceThrough
dure read <name> -f          # follow live

# Read one exact local or SSH backend Session without an app registry.
dure read <session-id> --workspace <workspace-id> --backend <id>
dure send <name> "message"    # explicit terminal control only; never an orchestration transport
```
