---
name: dure-computer
description: Drive the macOS desktop from `dure computer` — list running apps, read the frontmost app and its window titles, bring an app forward, type text, send a key chord, click a menu item, and capture the screen. Use when a task needs a native macOS app outside Dure, when asked to "click", "type into", "activate" or "screenshot" an app, or to check what is in front.
---

# Dure computer

`dure computer` is a thin osascript and `screencapture` wrapper: seven
subcommands, no accessibility tree, no coordinate clicks, no per-window capture.
Enough to drive an app by menu and keyboard; for a web page use `dure browser`.

## Permissions decide whether any of this works

macOS normally attributes these permissions to **the app hosting your shell**
— Dure, Terminal, iTerm. Grant access in System Settings; the CLI cannot grant
it for you.

- **Accessibility** is required by the native events in `type` and `key`, and
  the System Events work in `menu` and `state`'s window query. Name lookup and
  System Events commands may also need Automation consent. `activate` selects an
  existing process through AppKit; it does not send a launch event to an app.
  The older `apps`, `state` and `menu` error path still appends an Accessibility
  hint regardless of cause. A denied `state` exits 1 without state output.
- **Screen Recording** is required by `screenshot`, and a denial is not reliably
  an error: macOS can return a capture with the windows omitted while
  `screencapture` exits 0 and the CLI prints a path. Check the image, not the code.
- `apps` is the cheap probe — System Events only, so a fresh machine may prompt
  for Automation consent and nothing more. Run it before blaming a command;
  `state` is no substitute, exiting 1 without state output on a window-query error.

Every failure exits 1 with the message on stderr. Input activation has a
5-second deadline; the osascript subprocess has a 15-second deadline.

## Look before you act

```sh
dure computer apps            # one visible app name per line
dure computer state           # frontmost: <app>  /  windows(<app>): <titles>
dure computer state --app Safari
```

`state` reports the frontmost app and the window titles of that app, or of
`--app` when given. Both commands are read-only and steal no focus.

## Acting on an app

```sh
dure computer activate --app Safari
dure computer type Notes hello world
dure computer type --app Notes hello world
dure computer type --app Notes --text "hello world"
dure computer key Notes cmd+s
dure computer key --app Notes cmd+s
dure computer key --app Notes --key cmd+s
dure computer type --pid 12345 "hello world"
dure computer menu Safari File "New Window"
dure computer menu --app Safari File "New Window"
```

`activate`, `type` and `key` require an already running app. They resolve a name
to one PID and pin its kernel process identity before activating it. A missing
app is not launched. Multiple matches fail with `computer_app_ambiguous` and
the candidate PIDs; choose one with `--pid` instead of `--app`. The PID example
above is a placeholder, not a PID to copy without observing your own target.

Activation waits for the selected process to become frontmost, up to 5 seconds.
The process identity and focus are checked again immediately before and after
input. Exit, replacement or focus loss before input refuses the operation.
If dispatch raises an error or the target changes afterward, the command
returns `computer_input_unconfirmed`: some or all input may already have been
sent. Inspect the app before retrying; input commands are never retried for you.

These commands take focus. Both `type` and `key` post native events to the
pinned PID. `type` preserves Unicode, checks focus between characters and leaves
the clipboard unchanged. `key` resolves printable keys using the current
ASCII-capable keyboard layout without switching the input source. Characters
unavailable in that layout fail; use `type` for Unicode text. Apps may interpret
keyboard events differently; verify the result. Focus and process checks are
not atomic with event dispatch. Success means the dispatch returned and the
final process/focus check passed, not that
the intended text or application action was verified. Use an arranged test
window for native QA and avoid concurrent desktop interaction.

Give the app once, either as the first positional argument or with `--app`.
When `--app` is present, every positional argument belongs to the command's
payload: `type --app Notes hello world` types both words. For `type` and `key`,
choose positional input or `--text`/`--key`; combining them is an error.
`menu` accepts both app forms and requires exactly one menu and one item.

`--help` and `-h` anywhere before a literal `--` print help without activating
an app, typing, clicking or capturing the screen. This also applies after
`--text` or `--key`. Put literal arguments beginning with `-` after `--`:

```sh
dure computer type --app Notes -- --help --json
```

Unknown commands, unsupported options (including `--json`), duplicate options,
missing values and extra arguments are rejected before any OS action.

Key syntax is `[modifier+…]base`. Modifiers: `cmd`/`command`, `ctrl`/`control`,
`alt`/`opt`/`option`, `shift`. Named bases: `return`/`enter`, `tab`, `space`,
`esc`/`escape`, `delete`/`backspace`, `up`, `down`, `left`, `right`, `home`,
`end`, `plus`. A base can also be one printable character. Use `+` or `plus`
for a literal plus sign, and `cmd+plus` with a modifier. Names and letters are
case-insensitive; use `shift+a` for Shift-A. Unknown or repeated modifiers,
empty bases and unsupported names such as `F5` are rejected before activation.
Use `type` to send multiple characters.

`menu` clicks by exact title in menu bar 1, so the item must already be visible
and enabled; it does not walk submenus.

## Screenshots

```sh
dure computer screenshot            # prints the path it chose
dure computer screenshot /tmp/x.png
```

The whole screen is captured silently. With no path the file lands under the
app-channel directory (`~/.dure`, or `~/.dure/channels/<channel>`) as
`screenshot-<epoch-ms>.png`, and the only output is that path — read it back
rather than guessing the name. Nothing prunes these, so delete the ones you
took once you are done reading them.

## If `dure` does not recognize something here

This file installs separately from the binary, so it can be older or newer than
the `dure` on PATH. When a command or flag documented as supported above is
rejected as unknown, that mismatch is the likely cause — do not invent a
different spelling, and do not abandon the task silently. Read the real grammar
from `dure <command> --help`,
check `dure skills status` for whether this skill reports `outdated`, and run
`dure skills install --global` to bring every shipped skill back in step with
the installed CLI.
