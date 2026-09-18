import { BrowserCommandError } from "./browser-command-error.mjs";

const namedValues = ["element", "value", "input", "what", "direction", "amount", "expression", "selector", "load", "fn", "key", "width", "height", "latitude", "longitude", "from", "to", "files", "x", "y", "button", "dy", "dx", "locator", "action", "headers"];

export function parseBrowserArguments(args, { nativeValues = false } = {}) {
  const options = { positional: [] };
  const names = new Map([
    ["--workspace", "workspace"], ["--backend", "backend"], ["--page", "page"],
    ["--worktree", "worktree"], ["--resource", "resource"], ["--space", "space"],
    ["--after", "after"], ["--days", "days"],
    ["--controller", "controller"], ["--epoch", "epoch"],
    ["--idempotency-key", "operationId"], ["--output", "output"],
    ["--timeout", "timeout"], ["--state", "state"],
    ["--name", "name"], ["--index", "index"],
    ["--format", "format"], ["--quality", "quality"],
    ["--command", "execCommand"],
    ["--categories", "categories"],
    ["--recording", "tracingRecording"],
    ["--depth", "depth"],
    ["--baseline", "baseline"], ["--threshold", "diffThreshold"],
    ["--patterns", "patterns"], ["--body", "body"], ["--status", "status"], ["--content-type", "contentType"], ["--response-headers", "responseHeaders"], ["--resource-type", "resourceTypes"], ["--resource-types", "resourceTypes"],
    ["--limit", "limit"], ["--before", "before"],
    ["--filter", "networkFilter"], ["--type", "networkType"], ["--method", "networkMethod"],
    ["--user", "user"], ["--pass", "pass"],
    ["--text", "text"],
    ["--label", "label"], ["--scope", "scope"], ["--profile", "profileId"],
    ["--url", "url"], ["--domain", "domain"], ["--path", "path"],
    ["--curl", "cookieFile"],
    ["--same-site", "sameSite"], ["--sameSite", "sameSite"], ["--expires", "expires"],
    ["--accuracy", "accuracy"], ["--scale", "scale"], ["--color-scheme", "colorScheme"], ["--reduced-motion", "reducedMotion"],
    ...namedValues.map((name) => [`--${name}`, name]),
  ]);
  const booleans = new Map([
    ["--full", "diffFullPage"], ["--only-dynamic", "onlyDynamic"],
    ...["interactive", "compact", "urls", "cursor", "annotate", "focus", "secure", "mobile", "abort", "exact"].map((name) => [`--${name}`, name]),
    ["--show-profile", "showProfile"], ["--no-ua-spoof", "noUaSpoof"],
    ["--http-only", "httpOnly"], ["--httpOnly", "httpOnly"],
  ]);
  const duplicate = (flag) => {
    throw new BrowserCommandError("browser_command_invalid", `Option ${flag} was supplied more than once.`, "Supply this option once; alternate spellings count as the same option.", flag);
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") {
      options.positional.push(...args.slice(index + 1));
      break;
    }
    if (argument === "--json") continue;
    if (booleans.has(argument)) {
      const name = booleans.get(argument);
      if (options[name] !== undefined) duplicate(argument);
      options[name] = true;
      continue;
    }
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    const value = () => {
      if (equals >= 0) return argument.slice(equals + 1);
      const next = args[index + 1];
      const nextFlag = next?.split("=", 1)[0];
      // Native command strings have their own value grammar. Preserve their
      // already-translated literal values; outer CLI flags use this guard.
      const optionValue = names.has(nextFlag) || booleans.has(nextFlag) || ["--", "--json", "--enable", "--init-script", "-h"].includes(nextFlag);
      if (next === undefined || (!nativeValues && optionValue)) {
        throw new BrowserCommandError("browser_command_invalid", `Option ${flag} requires a value.`, `Supply a value after ${flag}. For a literal value starting with --, use ${flag}=VALUE.`, flag);
      }
      return args[++index];
    };
    if (flag === "--enable") {
      (options.enabledFeatures ??= []).push(value());
      continue;
    }
    if (flag === "--init-script") {
      (options.initScriptFiles ??= []).push(value());
      continue;
    }
    if (names.has(flag)) {
      const name = names.get(flag);
      if (options[name] !== undefined) duplicate(flag);
      options[name] = value();
    } else if (argument.startsWith("--")) {
      throw new BrowserCommandError("browser_command_invalid", `Unknown option ${flag}.`, "Run dure browser --help to see supported options. Put literal positional values after --.", flag);
    }
    else options.positional.push(argument);
  }
  normalizeNamedArguments(options);
  return options;
}

/** Both syntaxes converge before backend, workspace or input admission. */
function normalizeNamedArguments(options) {
  const words = options.positional;
  const command = words[0];
  const setValues = { device: "name", headers: "headers", offline: "state" };
  const present = (...keys) => keys.some((key) => options[key] !== undefined);
  const take = (key, required = true) => {
    const value = options[key];
    if (required && value === undefined) throw new Error("browser_command_invalid");
    delete options[key];
    return value;
  };
  const scoped = () => present("workspace", "worktree");
  const rewrite = (prefix, canonical, values, references = []) => {
    const resource = words.slice(prefix);
    if (resource.length > 1 || (resource.length && (scoped() || present("resource")))) throw new Error("browser_command_invalid");
    if (resource.length) options.resource = resource[0];
    options.positional = [canonical, ...values];
    // References already contain the exact resource. Only raw targets without
    // an explicit resource/workspace need the backend's local-cwd resolver.
    if (!scoped() && !present("resource") && !references.some((value) => value?.trimStart().startsWith("@"))) options.worktree = "current";
  };
  const element = () => {
    if (present("element") && present("selector")) throw new Error("browser_command_invalid");
    return present("selector") ? take("selector") : take("element");
  };

  if (["screenshot", "full-screenshot"].includes(command) && present("element", "selector")) {
    options.captureElement = element();
  } else if (["click", "dblclick", "check", "uncheck", "focus", "clear", "select-all", "hover", "scrollintoview", "highlight", "frame"].includes(command) && present("element", "selector")) {
    const target = element();
    rewrite(1, command, [target], [target]);
  } else if (["fill", "select"].includes(command) && present("element", "value")) {
    const target = take("element");
    rewrite(1, command, [target, take("value")], [target]);
  } else if (["get", "is"].includes(command) && present("what", "element")) {
    const what = take("what");
    const target = take("element", !["url", "title"].includes(what));
    const values = [what, ...(target === undefined ? [] : [target])];
    if (what === "attr") values.push(take("name"));
    rewrite(1, command, values, [target]);
  } else if (command === "type" && present("input")) {
    rewrite(1, command, [take("input")]);
  } else if (command === "inserttext" && present("text")) {
    rewrite(1, command, [take("text")]);
  } else if (["key", "keypress", "keydown", "keyup"].includes(command) && present("key")) {
    rewrite(1, command, [take("key")]);
  } else if (["goto", "pushstate"].includes(command) && present("url")) {
    rewrite(1, command, [take("url")]);
  } else if (command === "eval" && present("expression")) {
    rewrite(1, command, [take("expression")]);
  } else if (command === "scroll" && present("direction", "amount")) {
    rewrite(1, command, [take("direction"), take("amount", false) ?? "300"]);
  } else if (command === "drag" && present("from", "to")) {
    const from = take("from");
    const to = take("to");
    rewrite(1, command, [from, to], [from, to]);
  } else if (command === "upload" && present("element", "files")) {
    const target = take("element");
    const files = take("files").split(",").map((value) => value.trim());
    if (files.some((value) => !value)) throw new Error("browser_upload_files_invalid");
    rewrite(1, command, [target, ...files], [target]);
  } else if (command === "download" && present("selector", "element", "path")) {
    const target = element();
    if (present("path")) {
      if (present("output")) throw new Error("browser_command_invalid");
      options.output = take("path");
    }
    rewrite(1, command, [target], [target]);
  } else if (command === "viewport" && present("width", "height")) {
    rewrite(1, command, [take("width"), take("height")]);
  } else if (["geo", "geolocation"].includes(command) && present("latitude", "longitude")) {
    rewrite(1, "geo", [take("latitude"), take("longitude")]);
  } else if (command === "find" && present("locator", "value", "action", "text")) {
    const values = [take("locator"), take("value"), take("action")];
    if (present("text")) values.push(take("text"));
    rewrite(1, command, values);
  } else if (command === "wait" && (present("selector", "text", "url", "load", "fn") || (words.length <= 2 && present("timeout")))) {
    // The pinned engine selects one condition by this priority, not flag order.
    const conditions = ["url", "load", "fn", "text", "selector"].filter((key) => present(key));
    const kind = conditions[0];
    const values = kind ? [kind === "fn" ? "function" : kind, take(kind)] : ["duration", take("timeout")];
    for (const ignored of conditions.slice(1)) take(ignored);
    if (kind !== "selector") take("state", false);
    rewrite(1, command, values);
  } else if (command === "state" && (words[1] === "load" && words.length === 3 || words[1] === "save" && [2, 3].includes(words.length))) {
    rewrite(words.length, command, words.slice(1));
  } else if (command === "cookie" && ["get", "set", "delete", "clear"].includes(words[1]) && (words.length === 2 || present("name", "value"))) {
    const operation = words[1];
    const values = [operation];
    if (present("cookieFile") && present("name", "value")) throw new Error("browser_command_invalid");
    if (operation === "delete" || (operation === "set" && !present("cookieFile"))) values.push(take("name"));
    if (operation === "set" && !present("cookieFile")) values.push(take("value"));
    rewrite(2, command, values);
  } else if (command === "storage" && ["local", "session"].includes(words[1]) && ["get", "set", "clear"].includes(words[2]) && (words.length === 3 || present("key", "value"))) {
    const values = [words[1], words[2]];
    if (words[2] === "set" || (words[2] === "get" && present("key"))) values.push(take("key"));
    if (words[2] === "set") values.push(take("value"));
    rewrite(3, command, values);
  } else if (command === "mouse" && ["move", "down", "up", "wheel"].includes(words[1]) && (words.length === 2 || present("x", "y", "button", "dy", "dx"))) {
    const action = words[1];
    const values = [action];
    if (action === "move") values.push(take("x"), take("y"));
    else if (action === "wheel") {
      values.push(take("dy"));
      if (present("dx")) values.push(take("dx"));
    } else if (present("button")) values.push(take("button"));
    rewrite(2, command, values);
  } else if (command === "set" && ((words[1] === "credentials" && words.length === 2) || (Object.hasOwn(setValues, words[1]) && present(setValues[words[1]])))) {
    const action = words[1];
    if (action === "credentials") rewrite(2, command, [action]);
    else rewrite(2, action, [take(setValues[action])]);
  } else if (command === "dialog" && ["status", "accept", "dismiss"].includes(words[1]) && (words.length === 2 || present("text"))) {
    const values = [words[1]];
    if (present("text")) values.push(take("text"));
    rewrite(2, command, values);
  } else if (command === "clipboard" && ["read", "write"].includes(words[1]) && words.length === 2) {
    // Clipboard's existing parser already consumes its --text option.
    rewrite(2, command, [words[1]]);
  } else if (command === "capture" && ["start", "stop", "status"].includes(words[1]) && words.length === 2) {
    rewrite(2, command, [words[1]]);
  }

  if (namedValues.some((key) => present(key) && !(["snapshot", "diff"].includes(command) && key === "selector"))) throw new Error("browser_command_invalid");

  const zeroArgument = words.length === 1 && ["show", "snapshot", "screenshot", "full-screenshot", "pdf", "back", "forward", "reload", "network", "console", "control", "close"].includes(command);
  const tab = command === "tab" && ((words.length === 2 && ["list", "current", "show", "create", "switch", "close"].includes(words[1])) || (words.length === 3 && words[1] === "profile" && options.page?.trim() && ["show", "set", "clone", "use-default"].includes(words[2])));
  if ((zeroArgument || tab) && !scoped() && !present("resource") && !options.captureElement?.trimStart().startsWith("@")) options.worktree = "current";
}
