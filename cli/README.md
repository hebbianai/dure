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
