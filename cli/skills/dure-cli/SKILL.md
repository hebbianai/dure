---
name: dure-cli
description: Choose the right identifier for a `dure` command, control where a spawned agent's files land, and read, drive and wait on a session from the CLI. Use alongside the `dure` skill when asked to inspect sessions or Spaces, read or send to a pane, send keys, or wait for an agent to finish — and when a Run must land in its own worktree.
---

# Dure CLI

The `dure` skill owns coordination and spawning — another agent, schedules,
orchestration, client pane control — and `dure --help` lists every command.
This covers what neither does: picking the identifier a command wants, the
`dure run` options that decide where an agent's files land, and reading,
driving and waiting on a session. Parse `--json` — `dure.sessions/v1`,
`dure.wait/v1`, `dure.send/v1` are versioned; the text form is for a human.

## Pick the identifier first — most failures are a mismatch, not a bad command

- **Agent name** (`worker`, or `project/worker` when ambiguous) — `read`,
  `send`, `send-keys`, `wait`, `logs`, `enter`, `stop`. Resolved through the client
  registry, so only for an agent a client has seen.
- **Agent id** (`agent-…`) — `stop` also accepts this exact identity; it is not
  the Session ID consumed by `attach` or backend session reads.
- **Session id + workspace id** (`session_…`, `agent-workspace:…`) — the
  registry-free pair. `attach` requires both; `wait` and `read` accept them in
  place of a name, and `read` demands them once `--backend` or
  `DURE_BACKEND_PROFILE` selects a backend. `inspect` needs only the session id.
- **Space/pane id** (`desk-…`, `pane-…`) and **project id** — consumed by
  `dure run --space`, `dure run --project` and `dure client`, all in the `dure` skill.

```sh
dure ls   # SESSION WORKSPACE PROVIDER PID LIVE CWD AGENTS FAILURE
dure spaces show desk-Jd7tlL   # pane id, type, title, state, workspace/session
dure projects list             # project ids; dure spaces list gives desk ids
```

`FAILURE`, not `LIVE`, is the column that explains a broken session.

For a full backend inventory, start with `dure ls --cursor start --json` and
pass each `pagination.nextCursor` back to `--cursor` until it is `null`. Keep
the same backend for every page. This includes sessions without client panes.
`inventoryComplete` means no identities remain after this page;
`observationComplete` means every returned session was probed. `complete` alone
does not mean every session was returned. Pages use workspace/session ordering
over the live catalog, not a frozen snapshot: restart from `start` to reconcile
sessions created behind the cursor while traversing. Older runtimes without
pagination support return an explicit capability error.

## Where `dure run` puts the files

```sh
dure run --path /repo --provider codex --worktree fix-890 "…"
```

**Without `--worktree NAME` the Run lands in the project root** — a checkout
someone else may be editing. Name one whenever the agent will touch files; its
branch defaults to `agent/<name>`, and `--base-commit`, `--branch` and
`--setup-command` are rejected without it.

Omit `--idempotency-key` and the CLI invents one, printing `Retry key: …` on
**stderr**; keep it, because the same key resumes the one durable plan instead
of creating a second agent. Exit 0 succeeded, 1 the receipt is not `succeeded`,
2 the backend or pane placement failed — and success means setup and prompt
delivery finished, never that the provider answered.

## Stop and clean up an Agent

To stop and clean up an Agent, use `dure stop <agent-name-or-id> --yes --json`.
The selected running Dure app routes the stop to the Agent's owning backend,
then removes its registration and panes while preserving its workspace and
conversation history. `dure hmux stop --name ... --yes --json` uses the same path.
Do not substitute `/exit`, Ctrl-C or PID killing for the lifecycle command.
On uncertain results, retry the same Agent ID; success is `ok: true` and exit 0.
See `dure stop --help`. This client-scoped command does not accept `--backend`.

## Read a pane and send to it

```sh
dure read worker -n 80            # snapshot; -f follows until interrupted
dure read worker -n 80 --json     # one snapshot with lines[] and sequenceThrough; not with -f
dure send worker "run the tests"  # text plus Enter
dure send worker --stdin --no-enter
dure send-keys worker Escape Up Enter
```

A `send` receipt proves bytes reached the PTY, not that the provider accepted
them. `--no-enter` differs by surface: structured chat leaves an unsubmitted
draft for a human to Send, while a native PTY agent gets the bytes at once — so
there a following `read` should change, and an unchanged screen means the send
did not land. `send-keys` needs a local managed terminal, not SSH or chat.

## Wait rather than poll `read`

```sh
dure wait worker --timeout 900 --json  # seconds, default 600
dure wait --operation-id <id> --json   # the run request, not its answer
dure wait --task <id> --dispatch <id> --generation <n> --json  # delegated task
```

The three targets are exclusive, and each rejects the others' flags: with
`--task` only `--backend`, `--timeout`, `--deadline-ms` and `--json` are
allowed, all three of `--task`, `--dispatch` and `--generation` are required,
and the generation must be a positive integer. That target completes when the
worker calls `dure workflow done` for the same three values — see the `dure`
skill.

`wait <agent>` completes on the first Host-reported turn **after** it takes its
own snapshot, so start it before or right after the `send` it should observe.
To resume a wait, or make that first observation exact, pass `--after-turn` and
`--terminal-epoch` from `dure inspect <session> --json`. A show report wraps its
one session, so both fields nest under it:
`session.runtime.agentRuntimeState.turnCompletedCount` and
`session.runtime.generation.terminalEpoch`. A rehost changes the generation and
the old wait then can never complete. Exit 0 met, 1 failure, 2 unknown, 124
deadline, 130 interrupted; the last two stop only you.

## If `dure` does not recognize something here

This file installs separately from the binary, so it can be older or newer than
the `dure` on PATH. When a command or flag named above is rejected as unknown, that
mismatch is the likely cause — do not invent a different spelling, and do not
abandon the task silently. Read the real grammar from `dure <command> --help`,
check `dure skills status` for whether this skill reports `outdated`, and run
`dure skills install --global` to bring every shipped skill back in step with
the installed CLI.
