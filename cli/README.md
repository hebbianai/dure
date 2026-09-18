# Dure CLI

The executable [dure.mjs](dure.mjs) and its [command modules](lib/) own command
syntax and receipts. Read the installed version's help instead of maintaining
a second command catalog:

```sh
dure --help
dure runtime --help
dure send --help
dure send-keys --help
```

For this checkout, use `node cli/dure.mjs --help`. Runtime requirements and
packaged files are declared in [package.json](package.json). Install through
`pnpm dure:install` or the installed CLI's `install --global` flow; do not copy
an individual script out of the immutable bundle.

Read-only inspection, runtime mutation and connected-client presentation have
different effects. A delivery receipt does not prove provider acceptance or
task completion, and a timeout does not prove that an operation stopped. Inspect
the exact target and retain the operation's idempotency key after an uncertain
result; never replay an input batch blindly.

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

Copyright (C) 2026 Hebbian AI. The Dure CLI is licensed under
[GNU GPL version 3 only (GPL-3.0-only)](LICENSE).
