// Validate all desktop input before invoking an OS command. The shared CLI
// parser accepts unrelated flags and cannot distinguish options from payloads.
export const COMPUTER_HELP = `dure computer <sub> — macOS desktop control (osascript)
  apps                              List running apps
  state [--app A]                    Show the frontmost app and window titles
  activate --app A                   Bring an app to the front
  type --app A <text...>              Type all text into an app
  type --app A --text "text"          Type an explicit text argument
  key --app A <return|cmd+s|…>         Send a key
  key --app A --key cmd+s             Send an explicit key argument
  menu --app A <menu> <item>          Click a menu item
  screenshot [path]                  Capture the screen and return its path

An app may also be the first positional argument:
  type <app> <text...>
  key <app> <key>
  menu <app> <menu> <item>
activate, type and key require an already running app. A name must match
exactly one process; use --pid PID instead of --app to choose an exact process:
  type --pid 12345 "hello world"
Activation waits up to 5 seconds. Process identity and focus are checked
before and after input. Keyboard events target the PID; focus checks are not
atomic with dispatch. Re-observe after uncertain input before retrying.
Success reports dispatch, not the app's resulting content.
Use either positional text/key or --text/--key, not both.
Use -- before literal arguments beginning with - (including --help):
  type --app Notes -- --help
--help and -h before -- print help without desktop actions.
Unknown options, extra arguments and unsupported keys are rejected.

Keys: one printable character, return/enter, tab, space, esc/escape,
delete/backspace, up, down, left, right, home, end, plus.
Modifiers: cmd/command, ctrl/control, alt/opt/option, shift.
Use + or plus for a literal +, and cmd+plus with a modifier.
Function keys such as F5 are not supported.
Printable keys must exist in the current ASCII-capable keyboard layout.
Use type for Unicode text.

Accessibility and Screen Recording permissions are required.`;

const COMMAND_OPTIONS = new Map([
  ["apps", []],
  ["state", ["--app"]],
  ["activate", ["--app", "--pid"]],
  ["type", ["--app", "--pid", "--text"]],
  ["key", ["--app", "--pid", "--key"]],
  ["menu", ["--app"]],
  ["screenshot", []],
]);
const MODIFIERS = new Map([
  ["cmd", "command down"], ["command", "command down"],
  ["ctrl", "control down"], ["control", "control down"],
  ["alt", "option down"], ["opt", "option down"], ["option", "option down"],
  ["shift", "shift down"],
]);
const KEY_CODES = new Map([
  ["return", 36], ["enter", 36], ["tab", 48], ["space", 49],
  ["esc", 53], ["escape", 53], ["delete", 51], ["backspace", 51],
  ["up", 126], ["down", 125], ["left", 123], ["right", 124],
  ["home", 115], ["end", 119],
]);

function parseKey(key) {
  const parts = key === "+" ? ["plus"] : key.toLowerCase().split("+");
  const base = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const modifier = MODIFIERS.get(part);
    if (!modifier) throw new Error(`Unknown key modifier: ${JSON.stringify(part)}.`);
    if (modifiers.includes(modifier)) {
      throw new Error(`Duplicate key modifier: ${JSON.stringify(part)}.`);
    }
    modifiers.push(modifier);
  }
  const code = KEY_CODES.get(base);
  const character = base === "plus" ? "+" : base;
  if (
    code === undefined &&
    ([...character].length !== 1 || /[\p{C}\s]/u.test(character))
  ) {
    throw new Error(
      `Unsupported key: ${JSON.stringify(key)}. Use a named key or one printable character; use cmd+plus for Command-+.`,
    );
  }
  return { code, character, modifiers };
}

function isOption(argument) {
  return argument.startsWith("-") && argument !== "-";
}

export function parseComputerArgs(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator < 0 ? args : args.slice(0, separator);
  // Help always wins before the literal separator, even after --text/--key.
  if (
    args.length === 0 || args[0] === "help" ||
    optionArgs.some((arg) => arg === "--help" || arg === "-h")
  ) {
    return { sub: "help" };
  }
  const [sub] = args;
  const allowed = COMMAND_OPTIONS.get(sub);
  if (!allowed) throw new Error(`Unknown computer command: ${sub}. See dure computer --help.`);
  const options = new Map();
  const positional = [];
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!isOption(argument)) {
      positional.push(argument);
      continue;
    }
    if (!allowed.includes(argument)) {
      throw new Error(`Unknown option for computer ${sub}: ${argument}. Use -- before literal arguments beginning with -.`);
    }
    if (options.has(argument)) throw new Error(`Duplicate option: ${argument}.`);
    const value = args[++index];
    if (value === undefined || isOption(value)) {
      throw new Error(`${argument} requires a value. Use -- before literal arguments beginning with -.`);
    }
    options.set(argument, value);
  }

  const takesApp = allowed.includes("--app");
  let pid;
  if (options.has("--pid")) {
    const raw = options.get("--pid");
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 1 || Number(raw) > 2_147_483_647) {
      throw new Error("--pid requires a positive process ID greater than 1.");
    }
    if (options.has("--app")) throw new Error("Choose either --app or --pid, not both.");
    pid = Number(raw);
  }
  const app = takesApp && pid === undefined
    ? options.get("--app") ?? positional.shift()
    : undefined;
  if (takesApp && pid === undefined && (app !== undefined || sub !== "state") && !app?.trim()) {
    throw new Error("An app name is required (--app <name> or the first positional argument).");
  }
  const result = { sub, app, ...(pid === undefined ? {} : { pid }) };
  if (sub === "type" || sub === "key") {
    const flag = sub === "type" ? "--text" : "--key";
    if (options.has(flag) && positional.length > 0) {
      throw new Error(`Use either ${flag} or positional ${sub === "type" ? "text" : "key"}, not both.`);
    }
    const value = options.get(flag) ?? (
      sub === "type" ? positional.splice(0).join(" ") : positional.shift()
    );
    if (!value) {
      throw new Error(sub === "type"
        ? "Text to type is required."
        : "A key is required (for example: return, tab, cmd+s).");
    }
    if (sub === "type") result.text = value;
    else {
      result.key = value;
      result.keyAction = parseKey(value);
    }
  } else if (sub === "menu") {
    result.menu = positional.shift();
    result.item = positional.shift();
    if (!result.menu || !result.item) {
      throw new Error("Usage: dure computer menu <app> <menu> <item> (or --app <app> <menu> <item>)");
    }
  } else if (sub === "screenshot") {
    result.path = positional.shift();
    if (result.path === "") throw new Error("Screenshot path must not be empty.");
  }
  if (positional.length > 0) throw new Error(`Too many arguments for computer ${sub}.`);
  return result;
}
