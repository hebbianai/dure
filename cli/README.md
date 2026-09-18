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

## Licensing

Copyright (C) 2026 Hebbian AI. The Dure CLI is licensed under
[GNU GPL version 3 only (GPL-3.0-only)](LICENSE).
