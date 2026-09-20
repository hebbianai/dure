---
name: dure-computer
description: Drive the macOS desktop from `dure computer` — list running apps, read the frontmost app and its window titles, bring an app forward, type text, send a key chord, click a menu item, and capture the screen. Use when a task needs a native macOS app outside Dure, when asked to "click", "type into", "activate" or "screenshot" an app, or to check what is in front.
---

# Dure computer

`dure computer` is a thin osascript and `screencapture` wrapper: seven
subcommands, no accessibility tree, no coordinate clicks, no per-window capture.
Enough to drive an app by menu and keyboard; for a web page use `dure browser`.

## Permissions decide whether any of this works

macOS grants these permissions to **the app hosting your shell** — Dure,
Terminal, iTerm — never to `dure` itself. A CLI cannot request them, and only
some of the failures below name the missing permission as the cause.

- **Accessibility** is required by the System Events work in `type`, `key`,
  `menu` and `state`'s window query; `activate` is a plain Apple Event and needs
  Automation consent for the target app instead. Every osascript failure appends
  the same Accessibility path (Privacy & Security → Accessibility) whatever the
  real cause, so read that line as "a permission", not as the answer. A denied
  `state` prints nothing at all, not even `frontmost:` — so a `state` that does
  print without a `windows(…)` line means the app genuinely has no windows.
- **Screen Recording** is required by `screenshot`, and a denial is not reliably
  an error: macOS can return a capture with the windows omitted while
  `screencapture` exits 0 and the CLI prints a path. Check the image, not the code.
- `apps` is the cheap probe — System Events only, so a fresh machine may prompt
  for Automation consent and nothing more. Run it before blaming a command;
  `state` is no substitute, exiting 1 silently without Accessibility.

Every failure exits 1 with the message on stderr. osascript is given 15
seconds; a modal dialog in the target app will burn that and time out.

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
dure computer menu Safari File "New Window"
dure computer menu --app Safari File "New Window"
```

`activate`, `type` and `key` each activate the app first; `type` and `key` then
pause briefly. They take focus from whatever the user is doing. Keystrokes go
to whatever is frontmost at that moment: never fire one at an app you have not
just checked with `state`.

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
missing values and extra arguments are rejected before any OS action. Input
validation does not check the current focus or prove that an app received input.

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
