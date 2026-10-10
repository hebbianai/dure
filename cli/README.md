# Dure CLI

The executable [dure.mjs](dure.mjs) and its [command modules](lib/) own command
syntax and receipts. Read the installed version's help instead of maintaining
a second command catalog:

```sh
dure --help
dure client --help
dure read --help
dure runtime --help
dure runs --help
dure send --help
dure send-keys --help
dure computer --help
```

For this checkout, use `node cli/dure.mjs --help`. Runtime requirements and
packaged files are declared in [package.json](package.json). Install through
`pnpm dure:install` or the installed CLI's `install --global` flow; do not copy
an individual script out of the immutable bundle.

Automatic stable-app startup refuses to replace a newer managed CLI package or
backend build with an older one. Open the current Dure app if it reports
`automatic Dure CLI downgrade refused`. Explicit CLI installation retains its
existing replacement behavior. Already shipped older apps may predate this guard.

Read-only inspection, runtime mutation and connected-client presentation have
different effects. A delivery receipt does not prove provider acceptance or
task completion, and a timeout does not prove that an operation stopped. Inspect
the exact target and retain the operation's idempotency key after an uncertain
result; never replay an input batch blindly.

Headless managed Runs accept local text and semantic keys by their exact Session
and workspace IDs, without opening a pane or registering a client Agent:

```sh
dure send SESSION "continue" --workspace WORKSPACE --json
dure send-keys SESSION Down Enter --workspace WORKSPACE --json
```

Both resolve and fence the current live Host generation. Inspect an interactive
prompt before selecting keys and read the Session afterward to verify its result.

Conversation recovery retains the original project and working folder. Recovery
commands reject `--project`, `--path` and `--cwd`. To move a stopped native Codex
conversation, explicitly select a project registered on its owning backend:

```sh
dure runs move AGENT --project DESTINATION --json
```

Review the returned source and destination paths, conversation identity, account
reference and source revision. Run the returned exact Apply command, which carries
`--move-plan` and requires `--confirm-restart`. Keep its status/retry commands after
response loss. The backend uses the runtime-transition journal, verifies the exact
history and source generation, resumes with the same conversation ID and an
explicit Codex working root, and commits the Agent workspace with the new runtime.
Original Run records remain launch provenance. Runtime inspection carries committed
move evidence so the shared pane projector and `runs open` can converge the exact
source generation to the destination. No project files are copied or
deleted. SSH requests run this operation on the selected backend; they do not move
history or credentials between hosts.

This first capability refuses live or unobservable sources, structured Chat,
Claude's project-scoped history, and retained checkout claims. Use the returned
reason to identify the unsupported boundary; do not relabel project metadata or
force-stop an active provider. When failed target startup reports `repair_required`,
the returned rollback command uses the existing revision-fenced runtime repair to
resume in the source folder. Its `runtime switch --expected-revision` retains the
source account unless an account change is explicitly requested. An uncertain
startup requires status inspection first.
Older backends refuse the new capability before effects. Desktop menu integration,
live idle transitions, retained-checkout handoff and Claude history relocation
remain separate acceptance work.

Moving a pane to another Space does not change its process's working directory.

Agent-facing instructions are packaged in [the Dure skill](skills/dure/SKILL.md)
and the separate [orchestration integration](../orchestration/integration/SKILL.md).
Customer-facing guides belong to [public documentation](../docs/public/).

Browser input errors retain their machine-readable `error.code` and include
`message`, `hint`, and an `option` name when applicable. Unknown or duplicate
options, missing option values, and invalid wait states are rejected before
backend selection. Supplied values are omitted from these diagnostics.
Use `--value=--json` to enter a literal value that matches a supported option;
use `--` before literal positional values. Native `browser exec --command`
strings retain their own value grammar.

## TypeSafe Jev evaluation

`dure jev evaluate` submits explicit state and typed questions to
[TypeSafe's evaluation API](https://docs.typesafe.ai/api). It works without a
running Dure app. Set `TYPESAFE_API_KEY` in the invoking process's environment,
save this non-sensitive example as `request.json`, then run
`dure jev evaluate request.json --json` (or pipe JSON to `dure jev evaluate -`).

```json
{
  "state": "The app crashes whenever I open Settings.",
  "questions": {
    "bug": {
      "type": "noul",
      "instructions": "Does this report broken application behavior?"
    },
    "area": {
      "type": "choice",
      "instructions": "Which area should be investigated first?",
      "criteria": { "settings": "Opening or using Settings", "other": null }
    },
    "impact": {
      "type": "score",
      "instructions": "How severe is the reported impact?",
      "criteria": ["Cosmetic", "One feature is impaired", "App cannot be used"]
    }
  }
}
```

The optional `model` defaults to `jev-latest`; use a published version ID for
repeatable model selection. Questions share one state and are evaluated
independently. Results preserve question IDs, the responding model, answers,
probability distributions, confidence and token usage. Noul is a probability
from 0 to 1; Score is a position between zero-based rubric levels.

The existing Dure MCP integration exposes the same operation as `jev_evaluate`,
with the request object as its arguments. Set `TYPESAFE_API_KEY` in the MCP
server's environment; the Codex integration forwards that variable by name
without storing its value. After installing a CLI bundle containing this tool,
update the integration and restart the provider to refresh tool discovery.
The source-checkout CLI is `node cli/dure.mjs jev evaluate request.json --json`.

The command sends only supplied input from the machine running the CLI or MCP
server, directly to TypeSafe, which bills API usage. Remote use needs the key
on that host; `--backend` does not route this operation. Dure does not collect
repository files, change the active coding model, or act on returned judgments.
Requests are bounded to 512 KiB, responses to 2 MiB, and API calls to 15 seconds;
TypeSafe's separate token budget also applies. Failures are not automatically
retried. A timeout can still have consumed tokens. `--json` emits typed error
receipts on stdout with exit code 2; successful evaluations exit 0.

## Licensing

Copyright (C) 2026 Hebbian AI. The Dure CLI is licensed under the
[Apache License, Version 2.0 (Apache-2.0)](LICENSE).

Message tracking: `dure send NAME --track "message" --json` returns a private
`receiptPath` for `dure wait --message PATH [--until observed|acknowledged|turn_started]`.
See `dure send --help` and `dure wait --help` for evidence limits. Native Codex
progress also appears in `dure inspect --json`, `dure ls`, and pane headers after
five quiet minutes of thinking. This is an observation, never an automatic stop.

### Scheduled operational tasks

Schedules retain isolated Git worktrees by default. Use `dure schedule create
--no-worktree --project ID --cron "0 9 * * *" -- "review operational status"`
for a registered project folder, including a non-Git directory. Runs then share
that folder. The selected backend must advertise `schedule.worktree_project_root_v1`;
older backends refuse the opt-in before a schedule is changed. Git-specific
`--base-commit`, `--branch` and `--setup-command` options cannot accompany it.

Scheduled Claude runs require an existing trust decision for the registered
project folder (or its parent) in the selected Claude account. Review the folder
and complete Claude's interactive startup in that account first. An untrusted
folder fails visibly with `schedule_claude_project_trust_required`; Dure does not
accept trust dialogs or turn bypass approvals into folder trust. After resolving
startup prompts, use a new run-once key or wait for the next occurrence.

`dure schedule runs` and `inspect` distinguish launch acceptance, current provider
attention, and the retained completion report. Backends advertising
`schedule.runtime_observation_v1` provide bounded, read-only runtime observations
and exact session/workspace IDs. Older backends retain their launch/report view.
Waiting or unavailable observation is not evidence of completion or exit;
inspect the session for startup prompts. Only the durable report marks completion.

`dure client project add PATH` returns the app registration plus `backendProject`:
the canonical local backend ID and schedule arguments, or an exact quoted
`dure projects register ... --path PATH --backend local` command. Failed discovery
is reported as unchecked. SSH guidance is executed on the owning SSH host, since
app host IDs are not backend profile IDs. Keep registration and schedule commands
on the same backend; app project IDs alone do not register backend projects.
