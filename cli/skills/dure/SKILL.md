---
name: dure
description: Coordinate with other Dure agents through the `dure` CLI — see who is running, start another agent on a project or Space, schedule durable runs, read or send to a teammate's terminal, place and close client panes, and reach the orchestration contract for dispatched work. Use when working as part of a multi-agent Dure session, when asked to check for instructions, hand work to another agent, run something on a schedule, or open work in a pane.
---

# Dure CLI

For website inspection and interaction in Dure, load the Browser guide with
`dure skills get dure-browser`. It owns existing-tab discovery and shared
control. For coordination, sessions and pane commands, read the guide below.

Use the `dure` executable selected for this session for both the guide and later
commands. If the session supplies an explicit CLI path, keep using that path;
do not switch to another installation after a failure.

Read the guide bundled with that executable before issuing commands:

```sh
dure skills get dure
```

The guide follows the installed CLI version and works without a running app.
Use that same CLI's `--help` for details not covered by the guide. If `skills get`
is unsupported, report the version mismatch and use `dure --help` and the relevant
command's `--help` for read-only discovery. Updating Dure restores the guide;
reinstalling this skill alone does not update the CLI. Do not guess mutations or
switch tools silently after another error.
