---
name: dure-browser
description: Use Dure's embedded browser for website inspection, navigation, form filling, scrolling, and screenshots. Prefer this for interactive web tasks in a Dure session, even when the user does not name a browser. Reuse the user's existing tabs and shared control. Separate automated test suites and explicit requests for another browser tool retain their own tooling.
---

# Dure Browser Use

Use Dure Browser for interactive website work in Dure and reuse existing tabs.
Explicit requests for another tool and isolated automated test suites retain
their own tooling. The guide covers discovery, page references, shared control,
recovery, and returning control to the user's pane.

Use the `dure` executable selected for this session for both the guide and later
commands. If the session supplies an explicit CLI path, keep using that path;
do not switch to another installation after a failure.

Read the guide bundled with that executable before issuing commands:

```sh
dure skills get dure-browser
```

The guide follows the installed CLI version and works without a running app.
Use that same CLI's `--help` for details not covered by the guide. If `skills get`
is unsupported, report the version mismatch and use `dure --help` and the relevant
command's `--help` for read-only discovery. Updating Dure restores the guide;
reinstalling this skill alone does not update the CLI. Do not guess mutations or
switch tools silently after another error.
