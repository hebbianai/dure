---
name: dure-feedback
description: Report a Dure product defect or idea with `dure feedback`, the same intake the in-app dialog uses. Use when Dure itself misbehaves — the app, the CLI, a pane, a session runtime — or when a surface an agent needed was missing, and when asked to "file feedback", "report this to Dure", or "send a bug report".
---

# Dure feedback

`dure feedback` posts one report to the same intake as the in-app dialog. It
never reads the app registry, so it works even when the app has never run on
this machine — which is exactly when you most need it.

## File one when Dure is the problem

File a report when **Dure itself** behaved wrong or was missing something: a
pane that would not attach, a CLI command whose output contradicted its help, a
capability you expected from the product and could not find. Say what you did,
what you expected, and what happened, in that order, and keep one report to one
problem.

Do not use it for a bug in the code you are working on, for something that
belongs in the repository's issue tracker, or as a way to ask a question — the
intake is one-way and nobody will answer you there. If the user is present and
the problem is theirs to judge, tell them first rather than filing silently.

## Choosing `--kind`

Defaults to `bug`. The CLI accepts exactly three values:

- `bug` — Dure did something wrong, or stopped doing something it does.
- `idea` — nothing is broken; a surface should exist or work differently.
- `other` — neither fits. Prefer one of the first two.

Anything else, including the wire-only `crash`, exits 2 without sending.

## Non-interactive use

```sh
dure feedback --kind bug "dure send-keys reported success over SSH but delivered nothing"
dure feedback --kind idea --json --yes -- "--json should be accepted after the text"
printf '%s\n' "$REPORT_BODY" | dure feedback --kind bug --json
```

Text comes from arguments if you pass any, else from stdin when stdin is not a
TTY, else from `$EDITOR` when both stdin and stdout are TTYs. Only that editor
path prompts for confirmation, so whenever you supply the text yourself you are
already non-interactive and `--yes` is a no-op; pass it only for a script that
could run with no text and a TTY attached. Stdin is read to EOF, up to 64 KiB.

The body is capped at 8000 characters and `--contact` at 200. The envelope also
carries a persistent device id and six environment values (app, channel, os,
arch, locale, window) — the same disclosure the in-app preview shows.

## Options come first, and `--` protects your text

The option set is closed: `--kind`, `--contact`, `--json`, `--yes`, `--help`,
`-h`. Any other token shaped like a flag is refused wherever it appears, and
even an allowed option is refused once it follows the first word of the text.
That refusal is the feature. Writing `the --contact flag is broken` as bare
arguments would otherwise mail the body "the is broken" and file "flag" as your
contact address, and you would never see it happen.

```sh
dure feedback -- "--kind is ignored when it comes after the text"
printf '%s' 'the --contact flag is broken' | dure feedback
```

Both forms above keep the dashes. A bare `-` and a negative number such as
`-5 fps` are ordinary text and need no escaping.

## Reading the result

On success the reference id is the only thing on stdout — `{"reference":"…"}`
with `--json`. Errors go to stderr, as `{"error":"…"}` under `--json`.

- **0** — accepted, reference returned.
- **1** — the report was built but not sent: a declined confirmation, network
  failure, rate limit (429), temporary outage (503), or a permanent rejection
  (400, or 413 for an oversized field). The message says which. Retrying helps
  only the transient three; a rejection will not change until the payload does.
- **2** — usage: unknown `--kind`, a misplaced or unknown flag, empty body,
  body or contact over the limit, no text and no `$EDITOR`.

`DURE_FEEDBACK_ENDPOINT` overrides the intake URL. Use it only for a test
intake you control; there is no dry-run flag, and every other invocation sends
for real.

## If `dure` does not recognize something here

This file installs separately from the binary, so it can be older or newer than
the `dure` on PATH. When a command or flag named above is rejected as unknown, that
mismatch is the likely cause — do not invent a different spelling, and do not
abandon the task silently. Read the real grammar from `dure <command> --help`,
check `dure skills status` for whether this skill reports `outdated`, and run
`dure skills install --global` to bring every shipped skill back in step with
the installed CLI.
