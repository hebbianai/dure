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

`dure whoami --json` returns the current registry identity and its `source`.
An explicit managed Session must have exactly one registry owner; missing or
ambiguous owners fail instead of selecting another agent from the same folder.
Outside a managed Session, `--agent NAME` can select a target explicitly. The
working-directory fallback requires one agent in the nearest matching worktree.
`dure logs --help` explains scrollback reads and works without a running app.

```sh
dure ls                      # canonical Sessions + exact liveness
dure ls --backend devbox --json
```

`ls` queries the selected backend's `sessions.list` authority. A connected
client may add presentation labels for an exact generation, but `agents.json`
is never the Session inventory or liveness source.

`dure inspect` accepts a Session ID. Given a `pane-...` ID, use
`dure client pane state <pane-id> --json` for the mounted pane, or
`dure client observe --json` to find its session/workspace binding. Inspect that
Session with its workspace and owning backend. `inspect --json` exposes
`conversationId` and `runtime.conversationIdentity` when observed by the Host;
it does not infer the provider's conversation log path.

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

# Select a registered project by stable ID or a directory within its root.
dure run --project project-id --provider codex "implement feature X"
dure run --path /workspace/project "run the full test suite"

# Open in one connected-client Space. ID is preferred; an exact unique name
# is also accepted.
dure run --space Build "investigate the failing test"

# A fresh backend has no implicit client registry. Register the repository once;
# --path defaults to the current directory and --name defaults to the stable ID.
dure projects register project-id
dure projects register project-id --path /workspace/project --name "Project"
dure projects register --help
```

`--project` and `--path` are mutually exclusive. Both select an existing backend
registration. `--path` selects the deepest registered project containing that
directory; it does not register a project or change the Run's working directory
to a child folder. With no selector, the current directory selects the project.
An unregistered path fails before a Run is created. Check `dure projects list`,
register explicitly with `dure projects register`, then retry using the same
Run idempotency key. Repeating the failed Run alone cannot add the registration.

`projects register` requires a stable ID of 1–64 lowercase letters, digits,
dots, underscores or hyphens, starting and ending with a letter or digit.
`--path` defaults to the current directory; local relative paths are resolved
there. SSH paths must be absolute on the selected backend and are not resolved
against the CLI host. `--name` defaults to the ID. Use `--backend ID` (or
`DURE_BACKEND_PROFILE`) consistently for registration and Run, `--json` for a
structured result, and `--deadline-ms N` for a 1–10000 ms request deadline
(default 2500). Registration creates no Run, pane or worktree. Nested help,
including `dure projects register --help` and `-h`, works offline.

The CLI previews and then applies one durable backend plan, so retries reuse
the same operation instead of creating a second agent.

Generated worktrees inside a checkout are excluded through Git's local
`info/exclude`, shared by interactive and scheduled Runs. This preserves tracked
ignore files and the index; files already tracked before the fix stay tracked.

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

## Switch an existing Agent's account

Claude and Codex use the same backend transition as the UI account selector.
It preserves the conversation and current Chat/Terminal mode. It works without
an open app, with local or SSH backends; keep the same `--backend ID` throughout.

```sh
dure recovery get claude --json   # registered account IDs/generations and policy
dure recovery get codex --json
dure runs switch-account worker --account ACCOUNT_ID --json  # preview only
dure runs switch-account worker --account ACCOUNT_ID --confirm-restart --json
```

Agents launched, resumed or imported by the app have no Run record; select them
by Agent ID, or by name or Session ID from `dure ls`. A closed, stopped Agent
restarts with the selected account and its retained conversation. An ambiguous
name is refused with each candidate's exact retry command; use the Agent ID.
Accounts must be
registered for that provider on the owning backend; display names are not IDs.
An unregistered account needs preparation through Dure's account settings first.
`--account default` explicitly selects the provider's default credentials.

Preview returns `continuation.start`, `retry` and `status`: retain these exact
commands. The apply/retry command pins the Agent, current mode, source revision,
account generation and request key. After response loss, inspect status before
retrying that command; do not repeat the name-based command with a new key.
The backend protects busy turns and unsubmitted input. A switch does not resend
failed work or enable automatic switching. A busy refusal is `refused`: nothing
changed, and `error.reasonCode` says why (`agent_working`, `agent_background_work`,
`agent_attention_required`, `controller_input_pending`). Wait for that work,
then run the same retry command; never force-stop a source to change accounts.
In Claude Code, exiting stops background tasks, and "Move to background and
exit" keeps the conversation running without a pane on the old account.

The lower-level equivalent is `dure runtime get AGENT_ID --json`, then:

```sh
dure runtime switch AGENT_ID terminal --account ACCOUNT_ID \
  --credential-generation GENERATION --expected-revision REVISION \
  --idempotency-key KEY --json
```

Use `chat` for a structured Chat source. Copy account/generation from `recovery
get` on the same backend. For default credentials, pass `--account default` and
omit `--credential-generation`.

Automatic recovery is a separate opt-in backend policy. `dure recovery --help`
describes `get`, revision-fenced `put`, and read-only `status AGENT_ID`. The policy
uses only explicitly allowed accounts; configuring it may require Dure Pro.
Never enable it or select additional accounts without the user's authorization.

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
current existing runtime without launching another provider. `resume` preserves
the conversation: a confirmed stopped source with a waiting deferred target uses
backend wake; an existing native source uses the local recovery broker. Both work
without an open app and publish the new binding. A retained Run record alone does
not prove reboot recovery is possible.

Resume, Refresh and runtime/account switching keep the Agent's original project
and working folder. Recovery still rejects `--project`, `--path` and `--cwd`.
Use `dure runs move AGENT --project REGISTERED_ID --json` to preview moving an
idle or stopped Claude or Codex conversation on its owning backend. Review the
exact source, destination, conversation and credential reference, then use the returned Apply
command with its `--move-plan` and `--confirm-restart`. Retain the exact plan and
backend for retries. The shared runtime journal owns the workspace handoff; project
files and original launch provenance are preserved. It does not migrate hosts.

A live source requires a preview of its exact idle revision and output position.
Any activity after preview refuses the move; preview again only after the source
is retained and idle. The Agent keeps its original checkout claim across the move,
including reconnects and rollback. No worktree is deleted or copied.

Claude Terminal moves require CLI 2.1.223–2.1.284: its documented exact
`--resume UUID` lookup searches all project directories. Dure checks the installed version and selected
account's history before stopping; missing or ambiguous transcripts are refused.
It neither copies that history nor forks a new conversation. See the
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags).

Claude Terminal moves on CLI 2.1.285 and later are currently refused: `--resume`
may attach a running background worker in its original folder. The terminal stop fence does not own
that worker. The same official resume contract documents this change. Dure never
stops that independent worker or forks the conversation to work around it.

The desktop Agent toolbar's Move conversation action uses this same preview and
restart confirmation, followed by the backend's committed workspace projection.
An uncertain response retains the plan; Check status can confirm completion or
show the source-folder repair action. Reopening a pane recovers an unfinished
plan from the backend journal; a backend restart refreshes read authority for that
same owner and operation. Chat keeps its existing conversation binding, so drafts
and attachments remain in the same composer. Pending terminal input is preserved.

Chat and Terminal moves preserve their mode. Unobservable sources remain
unsupported. Do not force-stop working Agents or edit project metadata to simulate a move. A failed target with `repair_required`
can use the returned rollback command to resume in its source folder through the
same journal. Inspect status first after any uncertain response. Pane placement
in another Space remains independent of the provider's working directory.

Keep both `--expected-revision` and `--expected-operation-id` in the returned
repair command. They bind repair to the exact failed move even if another client
creates a failed successor without advancing the source revision. Reuse its
idempotency key after response loss. If an older backend refuses the operation
fence, update that backend instead of removing the flag.

Keep the returned status/retry commands if a response is uncertain. Inspect first,
then retry the exact request instead of repeating a name-based resume. Wake must
retain its operation ID, journal revision and idempotency key; no separate publish
is needed. Native rehost returns a separate publish command. Then use `open` to
place the recovered Run. Remote resume requires execution on its host.
For headless input/output, use the Session/workspace pair from `show` with
`read`, local `send`, and `send-keys`; an Agent name requires client registration. Direct Session
input verifies the current Host generation without requiring an app registry.
It does not support `--backend`, `--window-label`, or broker idempotency keys.
For a lookup failure, check the selected channel with `dure diagnostics --json`.

For an interactive terminal prompt in a headless Run, send semantic keys using
the exact IDs, without first opening a pane:

```sh
dure send-keys SESSION Down Enter --workspace WORKSPACE --json
```

Inspect the prompt before choosing keys. The receipt proves PTY delivery, not
that the provider accepted a choice; read the Session again to verify it.

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
Schedules use an isolated Git worktree by default. For operational tasks, pass
`--no-worktree` to run in the registered project root, including a non-Git folder:

```sh
dure projects register operations --path /workspace/operations --backend local
dure schedule create --project operations --backend local --no-worktree \
  --cron "0 9 * * *" --timezone UTC -- "review operational status"
```

Project-root runs share files; they provide no per-run Git isolation. Do not
combine `--no-worktree` with `--base-commit`, `--branch` or `--setup-command`.
This opt-in requires `schedule.worktree_project_root_v1` on the selected backend;
an older backend is refused before mutation. Existing schedules with no worktree
field retain isolated mode. Use the same backend for registration and schedules.

Before scheduling Claude, review and trust the registered project folder in the
same Claude account, completing its interactive startup prompts. A missing trust
decision fails with `schedule_claude_project_trust_required`; bypass approvals
does not grant folder trust. Never automatically answer a trust or arbitrary
startup prompt. After the user resolves it, use a new run-once key or the next
scheduled occurrence.

`schedule runs` and `schedule inspect` include current runtime attention and exact
session/workspace IDs when the backend supports `schedule.runtime_observation_v1`.
Input/approval attention calls for inspection; waiting can include a startup
dialog. Unavailable observation proves neither exit nor task completion. Old
backends keep the launch/report view. `launchState: started` is launch acceptance;
only the retained Dispatch completion report proves the task reported completion.

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
`cli.freshness` separately compares this CLI's package version with the verified
running app. `cli_older_than_app` means its commands and bundled guides may lag
even when frontend/backend compatibility is current. Use the verified
`cli.channelLauncher.path`, when available for the same channel, for subsequent
commands or obtain the current PATH from a new terminal in that app. Existing
agents can keep running. Inspect the new executable's `version`, `diagnostics`
and `skills get dure` before continuing; do not replay uncertain operations.
`diagnostics --check --require cli` requires a known current or newer CLI package.
The default requirements remain `app,hmux,path`; version freshness does not claim
wire compatibility or live Session health.
`app.webviewDiagnostics` retains bounded desktop warning/error evidence across
window closure and app restart. Each row has the native window label, severity,
source, known failure code, first/last timestamps and recurrence count. Unknown
content is `redacted`; messages, stacks and console arguments are never included.
Text output shows the last eight rows; `--json` includes up to 256 retained rows.
Older apps report `unavailable`. Capture is rate limited and abrupt crashes can
lose pending observations; absence of a row is not proof that no error occurred.

Its `selectedChannel` remains available even when the app descriptor is absent.
The `recovery` object provides read-only checks and session-preserving steps.
Hmux executable compatibility is not live backend or session health: run
`dure backend health --json`, `dure runs ls --json`, and then
`dure inspect <session-id> --workspace <workspace-id> --json` for the affected
session, keeping the same executable, channel and backend selection.

`app_stale_descriptor` means this app endpoint could not be verified; it does
not prove that any session exited. If the selected app stopped, reopen that
channel (for development, `pnpm app:dev` in its owning checkout). Managed sessions
run independently; reopening the app reconnects presentation. Save unsent
drafts before closing an app that is still running. Do not stop Hosts, delete
state, or create replacement Runs to repair app reachability. Keep the original
message receipt/idempotency key and inspect delivery before any resend.

`--check` is the opt-in automation contract: it grafts one `check` object onto
the same receipt — read `.check.required`, `.check.failed` and `.check.passed`,
not the top level — then exits non-zero when a selected runtime requirement is
not current. Without `--check`, degraded diagnostics still exit zero.

## Connected-client Space and pane control

Create a Space in the background through the connected app:

```sh
dure client space create --name "Review" --json
dure client space create --json
dure client space create --name "Review" --select --json
dure client space show <space-id> --json
```

Omitting `--name` uses the app's next default name. Creation returns
`space.spaceId` without changing the selected Space. Pass `--select` to select
and mount it. Use that ID for `space show` or
`pane create --space-id`. The MCP equivalent is `app_space_create` with an
optional `name`; it retains its existing create-and-select behavior. Older CLI
clients also retain selection. Background creation requires an app advertising
`space.create_background_v1`; a newer CLI refuses an older app before creating.
If the response is uncertain, inspect `client observe` /
`app_observe` before creating again.

Pane placement belongs to a connected Dure client, not to Hmux or the detached
control plane. Use the explicit client surface when a script needs the same
split or close transaction as the app:

```sh
dure client pane split <reference-session-id> \
  --reference-panel-id <pane-id> --direction right
dure client pane move <pane-id> --from-space-id <source-space-id> --space-id <target-space-id>
dure client pane close <pane-id> --space-id <space-id> --yes
dure client workspace open <pane-id> --space-id <space-id> --target cursor
dure client project add /repo --space <space-id-or-name>
dure client host add ec2-106 --json
dure client host add --hostname example.com --user ec2-user --identity-file ~/.ssh/key.pem --json
```

Open a local report or document with the same file viewer as the GUI:

```sh
dure client pane open file ./report.md --space-id SPACE --json
dure client pane open file "/path/to/report.html" --space Review --json
```

Use `client observe` to discover the exact Space ID or a unique name. Opening
selects that Space in its owning window without OS foreground focus. Relative
paths resolve against the CLI's working directory; run this on the connected
app host. This operation does not use `DURE_BACKEND_PROFILE`, copy remote files,
or accept `--host`, `--backend` or URLs (including `file://`). An SSH file remains
an SSH file in the GUI; an identical local path does not reuse its pane.

Markdown uses the rendered viewer. Ordinary HTML opens as source, while
`design/mockups/<cluster>/<Name>/<state>.html` uses the existing static preview
whose sandbox blocks scripts. Browser's URL restrictions still apply.
The GUI opener reuses or restores the document pane and preserves its draft.
The receipt's `pane.panelId`, `pane.spaceId`, `pane.file` and `mounted: true`
confirm placement, not successful file loading. Missing/unreadable files show
the same error or candidate picker as a GUI open. After an uncertain response,
inspect `client observe`; reopening the same path in the same Space reuses it.
An older app without `file_pane.open_v1` is refused before mutation.

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
backend-only `dure projects register` above. Its `backendProject` receipt reports
the canonical local backend project ID and schedule arguments when registered.
Otherwise it prints a quoted `projects register ... --backend local` command.
An unavailable/older backend is reported as unchecked, not unregistered. For an
SSH app project, run the printed command on its owning host; an app host ID is
not a backend profile ID. The app project ID is never a schedule project selector.
`split` creates the pane through the app's existing correlated transaction.

`host add` imports an SSH config alias or registers explicit connection fields
through the same durable Host transaction as the GUI. It creates no session and
returns the canonical `registration.host.id` for `client pane create --host ID`.
Repeated identical key/automatic registrations reuse the saved Host. The first
terminal creation provisions a missing remote Hmux before requesting a session;
installation errors are returned without creating a pane.
`pane move` uses the same transaction as the pane menu’s **Move to Space** and
Space drag. It preserves the pane ID, running session and selected Space. The
source pane is removed and one destination pane remains. Repeating the same
source/pane/destination is a no-op; inspect `client observe` after an uncertain
response before requesting a different move. It requires `pane.move_v1`.
`close` requires the exact Space and pane identity plus explicit confirmation;
it never selects a pane by focus or display name. `workspace open` resolves that
same exact pane generation and opens its local project or Agent worktree through
the app's native target catalog. It never falls back to a base repository or a
different editor. Omit `--target` only after a target has completed successfully
and become the client preference. All commands return typed JSON with `--json`.
If no Dure client is connected, they fail with `client_unavailable` without
treating `agents.json` as an authority.

Inspect `dure client pane state <panel-id> --json` for available actions. If it
offers `refresh`, `dure client pane act <panel-id> refresh --json` invokes the
same conversation recovery as the UI Refresh and Resume session controls,
including recovery after a source checkout has closed. For recovery without an
open app, use `dure runs resume` as described above.

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

A blank screen prints nothing on stdout and a note with its size on stderr;
JSON reads report `rows`, `columns` and `alternateScreen`. Codex and other
full-screen agents draw nothing while their pane is very short, so a blank read
does not mean the agent is idle: enlarge the pane or use `dure transcript <name>`.

```sh
dure read <name>             # snapshot of their terminal
dure read <name> --json      # snapshot with lines[] and sequenceThrough
dure read <name> -f          # follow live

# Read one exact local or SSH backend Session without an app registry.
dure read <session-id> --workspace <workspace-id> --backend <id>
dure send <name> "message"    # explicit terminal control only; never an orchestration transport
```

A terminal connection failure does not prove the session exited. If `dure client
pane state <pane-id> --json` offers `reconnect`, invoke `dure client pane act
<pane-id> reconnect --json` to retry the same session attachment. Its
`pending` result with `value.state: reconnecting` acknowledges the request; observe pane state again
to confirm attachment. It does not replay input or start a new provider.

If `dure send` reports `hmux_command_input_process_timeout`, delivery is unknown.
Use `dure read` and `dure inspect` to inspect the target before sending again.
Native failures preserve their delivery state; a missing receipt is not proof
that nothing reached the terminal. Direct input is never automatically retried.
`hmux_input_draft_pending` is different: it is a definite non-write because the
person has unsubmitted input in that terminal. Only their Enter clears it;
erased text does not. Retry later or send a `--track` message. A target whose
runtime predates the guard receives ordinary input with a stderr warning;
restarting that session enables the guard.

## Dispatch deadlines

Use `dure orchestration invoke dispatch.deadline.set '<body-json>' --json`
(or MCP `orchestration_dispatch_deadline_set`) to set one exact dispatch's due
time. Resolve that dispatch's context first; copy its `target`,
`interactionCapability` as `writeCapability`, and `dispatchRevision` as
`expectedDispatchRevision`. Include `schemaVersion: 1`, a unique
`idempotencyKey`, `dueAtMs` as absolute Unix milliseconds, and `changedAtMs` as
the current Unix milliseconds. Explicit `dueAtMs: null` clears the deadline.
Keep the complete body and key unchanged after an uncertain response.

Inspect with `dispatch.deadline.get` (MCP `orchestration_dispatch_deadline_get`):
`{ "schemaVersion": 1, "target": <exact target>, "readCapability": <interactionCapability> }`.
Keep capabilities private. Both operations require backend capability
`orchestration.dispatch.deadline_v1`; an older backend refuses the operation.

The backend checks stored deadlines every five seconds while running and catches
up after restart. An incomplete dispatch, including one blocked on a Decision,
receives one overdue observation per deadline setting. The coordinator receives
a normal informational Message through its existing durable inbox and GUI.
`deadline.overdueEventCursor` identifies the committed overdue event; `null` or
an absent cursor means it has not been recorded. Setting/clearing increments the
dispatch revision, so refresh context before subsequent writes or completion.
An exact retry returns the original setting receipt; `get` returns current state.

Overdue attention does not interrupt, fail, or complete the worker. Completion
before the backend's overdue transaction suppresses the notice. Clearing or
resetting preserves previously recorded notices. Wait timeouts and Host
`progress_unconfirmed` remain separate observations and never authorize an
interrupt. Explicit urgent delivery correlated to a provider turn is not
provided by these deadline operations.
