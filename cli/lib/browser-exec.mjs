import { parseBrowserArguments } from "./browser-arguments.mjs";
import { nativeSnapshotArguments } from "./browser-snapshot.mjs";
import { nativeDiffArguments } from "./browser-diff.mjs";
import { browserTabLabel } from "./browser-tabs.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

const routing = ["backend", "resource", "defaultResource", "page", "controller", "epoch", "operationId"];

/** Match Orca's command-string tokenization: quotes group text; there is no
 * expansion, escape processing or shell execution. Empty quoted words vanish. */
function commandWords(command) {
  if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command) > 64 * 1024 || command.includes("\0")) throw new Error("browser_exec_command_invalid");
  const words = []; let word = ""; let quote;
  for (const character of command.trim()) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) quote = quote ? undefined : character;
    else if (character === " " && !quote) { if (word) words.push(word); word = ""; }
    else word += character;
  }
  if (word) words.push(word);
  // The selected backend/page cannot be replaced by native connection flags.
  const selected = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (["--cdp", "--session"].includes(word)) { index++; continue; }
    if (!word.startsWith("--cdp=") && !word.startsWith("--session=")) selected.push(word);
  }
  return selected;
}

/** Interpret native spelling at the CLI boundary, then reuse the existing
 * operation parser and Host admission. Unsupported engine paths stay explicit. */
function nativeArguments(words) {
  const [command, ...values] = words;
  const literal = (name, ...args) => [name, "--", ...args];
  if (command === "diff") return nativeDiffArguments(values);
  if (command === "react") return ["react", ...values];
  if (["close", "quit", "exit"].includes(command)) return ["disconnect"];
  if (command === "window") {
    if (values[0] !== "new") throw new Error("browser_exec_command_invalid");
    return ["window-new"];
  }
  if (command === "tap") {
    if (!values.length) throw new Error("browser_exec_command_invalid");
    return literal("tap", values[0]);
  }
  if (command === "swipe") {
    if (!["up", "down", "left", "right"].includes(values[0])) throw new Error("browser_exec_command_invalid");
    const parsed = /^\+?[0-9]+$/.test(values[1] ?? "") ? Number(values[1]) : NaN;
    const distance = Number.isInteger(parsed) && parsed <= 4_294_967_295 ? parsed : 300;
    return literal("swipe", values[0], String(distance));
  }
  if (command === "fill") {
    if (!values.length) throw new Error("browser_exec_command_invalid");
    return literal("fill", values[0], values.slice(1).join(" "));
  }
  if (command === "type") {
    if (!values.length) throw new Error("browser_exec_command_invalid");
    if (values.slice(1).some((value) => value.startsWith("--"))) throw new Error("browser_exec_command_unsupported");
    return literal("find", "first", values[0], "type", values.slice(1).join(" "));
  }
  if (command === "keyboard" && ["inserttext", "insertText"].includes(values[0]) && values.length > 1) return literal("inserttext", values.slice(1).join(" "));
  if (command === "keyboard" && values[0] === "type" && values.length > 1) return literal("keyboard", "type", values.slice(1).join(" "));
  if (command === "eval") {
    if (["-b", "--base64"].includes(values[0])) {
      const encoded = values.slice(1).join(" ");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error("browser_exec_command_invalid");
      let script;
      try { script = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error("browser_exec_command_invalid"); }
      return literal("eval", script);
    }
    if (!values.length || values[0] === "--stdin") throw new Error("browser_exec_command_unsupported");
    return literal("eval", values.join(" "));
  }
  if (["open", "navigate", "goto"].includes(command)) {
    if (!values.length) throw new Error("browser_exec_command_unsupported");
    return ["goto", ...values];
  }
  if (command === "addinitscript" || command === "removeinitscript") {
    if (!values.length) throw new Error("browser_exec_command_invalid");
    return literal("init-script", command === "addinitscript" ? "add" : "remove", command === "addinitscript" ? values.join(" ") : values[0]);
  }
  if (command === "pushstate") {
    if (!values.length) throw new Error("browser_exec_command_invalid");
    return literal("pushstate", values[0]);
  }
  if (command === "press") return ["key", ...values];
  if (command === "scrollinto") return ["scrollintoview", ...values];
  if (command === "wait") return nativeWait(values);
  if (command === "snapshot") return nativeSnapshotArguments(values);
  if (command === "state" && (values[0] === "load" && values.length === 2 || values[0] === "save" && [1, 2].includes(values.length))) return literal("state", ...values);
  if (command === "state" && ["list", "show", "clear", "clean", "rename"].includes(values[0])) return values[0] === "clean" ? ["state", ...values] : literal("state", ...values);
  if (command === "cookies") {
    if (!values.length || (values.length === 1 && values[0] === "get")) return ["cookie", "get"];
    if (values.length === 1 && values[0] === "clear") return ["cookie", "clear"];
    if (values[0] === "set" && values.includes("--curl")) return ["cookie", ...values];
    if (values[0] === "set" && values.length >= 3) return ["cookie", ...values.slice(3), "--", ...values.slice(0, 3)];
    throw new Error("browser_exec_command_unsupported");
  }
  if (command === "storage" && values.length === 2 && !["get", "set", "clear"].includes(values[1])) return literal("storage", values[0], "get", values[1]);
  if (command === "console" && values.length === 1 && values[0] === "--clear") return ["console", "clear"];
  if (command === "errors") {
    if (!values.length) return ["errors"];
    if (values.length === 1 && values[0] === "--clear") return ["errors", "clear"];
    throw new Error("browser_exec_command_invalid");
  }
  if (command === "clipboard") {
    if (!values.length || (values.length === 1 && values[0] === "read")) return ["clipboard", "read"];
    if (values.length === 1 && ["copy", "paste"].includes(values[0])) return ["clipboard", values[0]];
    if (values[0] === "write" && values.length > 1) return literal("clipboard", "write", values.slice(1).join(" "));
    throw new Error("browser_exec_command_unsupported");
  }
  if (command === "network") {
    if (["route", "unroute"].includes(values[0])) return nativeRoute(values);
    if (values[0] === "request") {
      if (values.length !== 2) throw new Error("browser_exec_command_invalid");
      return literal("network", "request", values[1]);
    }
    if (values[0] === "requests") {
      const flags = new Set();
      for (let index = 1; index < values.length; index++) {
        const flag = values[index];
        if (!["--filter", "--type", "--method", "--status", "--clear"].includes(flag)) throw new Error("browser_exec_command_unsupported");
        if (flags.has(flag)) throw new Error("browser_exec_command_invalid");
        flags.add(flag);
        if (flag !== "--clear" && values[++index] === undefined) throw new Error("browser_exec_command_invalid");
      }
      return flags.has("--clear") ? literal("network", "clear") : ["network", ...values.slice(1)];
    }
    if (values[0] === "har") {
      if (values.length === 2 && values[1] === "start") return ["capture", "start"];
      if ([2, 3].includes(values.length) && values[1] === "stop") return ["capture", "stop", ...(values.length === 3 ? ["--output", values[2]] : [])];
    }
    throw new Error("browser_exec_command_unsupported");
  }
  if (command === "vitals" || command === "web-vitals") {
    const positional = values.filter(value => value !== "--json");
    if (positional[0] === "--url" && positional.length === 2) positional.shift();
    if (positional.length > 1 || positional.some(value => value.startsWith("--"))) throw new Error("browser_exec_command_invalid");
    return literal("vitals", ...positional);
  }
  if (command === "record") return literal("record", ...values);
  if (command === "trace" || command === "profiler") return [command, ...values];
  if (command === "screenshot") return nativeScreenshot(values);
  if (command === "pdf" || command === "download") {
    if (values.length !== (command === "pdf" ? 1 : 2)) throw new Error("browser_exec_command_invalid");
    return [command, "--output", values.at(-1), "--", ...values.slice(0, -1)];
  }
  if (command === "set") {
    if (values[0] === "media") {
      // The native grammar sets preferences using the browser-default media type.
      // Dark wins over light; unrecognized words do not become routing flags.
      const color = values.includes("dark") ? "dark" : values.includes("light") ? "light" : "no-preference";
      const motion = values.includes("reduced-motion") ? "reduce" : "no-preference";
      return ["media", "--color-scheme", color, "--reduced-motion", motion];
    }
    if (values[0] === "viewport" && values.length === 4) return ["set", "--scale", values[3], "--", ...values.slice(0, 3)];
    if (values[0] === "geolocation") return literal("set", "geo", ...values.slice(1));
    if (values[0] === "offline" && values.length <= 2) return literal("set", "offline", ["off", "false"].includes(values[1]) ? "off" : "on");
  }
  if (command === "tab") {
    if (!values.length || (values.length === 1 && values[0] === "list")) return ["tab", "list"];
    if (values[0] === "new") return ["tab", "create", ...values.slice(1)];
    if (values.length === 1 && values[0] === "close") return ["tab", "close"];
    const closing = values[0] === "close";
    const page = closing ? values[1] : values[0];
    if (values.length === (closing ? 2 : 1) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(page)) return ["tab", closing ? "close" : "switch", "--label", browserTabLabel(page)];
    if (values.length === (closing ? 2 : 1) && isDureDomainIdV1(page) && !page.startsWith("-") && !/^[0-9]+$/.test(page)) return ["tab", closing ? "close" : "switch", "--page", page];
    throw new Error("browser_exec_command_unsupported");
  }
  if (command === "frame") {
    if (words.length !== 2 || !words[1].trim()) throw new Error("browser_exec_command_unsupported");
    return ["frame", "--", words[1]];
  }
  if (["back", "forward", "reload", "click", "dblclick", "check", "uncheck", "focus", "hover", "highlight", "scrollintoview", "select", "drag", "scroll", "key", "keydown", "keyup", "mouse", "get", "is", "snapshot", "find", "set", "storage", "dialog", "console", "upload"].includes(command)) return words;
  throw new Error("browser_exec_command_unsupported");
}

function nativeRoute([command, pattern, ...values]) {
  if (command === "unroute" && pattern === undefined) return ["intercept", "disable"];
  if (!pattern || pattern.startsWith("-")) throw new Error("browser_exec_command_invalid");
  if (command === "unroute") {
    if (values.length) throw new Error("browser_exec_command_invalid");
    return ["intercept", "--", "remove", pattern];
  }
  const flags = new Map();
  for (let index = 0; index < values.length; index++) {
    const flag = values[index] === "--resource-types" ? "--resource-type" : values[index];
    if (!["--abort", "--body", "--resource-type"].includes(flag)) throw new Error("browser_exec_command_unsupported");
    if (flags.has(flag)) throw new Error("browser_exec_command_invalid");
    if (flag === "--abort") flags.set(flag, []);
    else {
      if (values[index + 1] === undefined) throw new Error("browser_exec_command_invalid");
      flags.set(flag, [values[++index]]);
    }
  }
  return ["intercept", ...[...flags].flatMap(([flag, value]) => [flag, ...value]), "--", "enable", pattern];
}

function nativeWait(values) {
  const aliases = { "-u": "--url", "-l": "--load", "-f": "--fn", "-t": "--text" };
  const flags = {};
  const positional = [];
  for (let index = 0; index < values.length; index++) {
    const flag = Object.hasOwn(aliases, values[index]) ? aliases[values[index]] : values[index];
    if (["--url", "--load", "--fn", "--text", "--timeout", "--state"].includes(flag)) {
      if (flags[flag] !== undefined || values[index + 1] === undefined) throw new Error("browser_exec_command_invalid");
      flags[flag] = values[++index];
    } else if (flag.startsWith("--") || flag.startsWith("-")) throw new Error("browser_exec_command_unsupported");
    else positional.push(flag);
  }
  if (positional.length > 1) throw new Error("browser_exec_command_invalid");
  const timeout = flags["--timeout"];
  if (timeout !== undefined && (!/^\+?[0-9]+$/.test(timeout) || BigInt(timeout) > 18446744073709551615n)) throw new Error("browser_exec_command_invalid");
  const condition = ["--url", "--load", "--fn", "--text"].find((flag) => flags[flag] !== undefined);
  if (!condition && !positional.length) throw new Error("browser_exec_command_invalid");
  // Native waits choose a condition by priority. A numeric wait uses its own
  // duration even when --timeout was also supplied.
  const kind = condition ? ({ "--url": "url", "--load": "load", "--fn": "function", "--text": "text" })[condition] : /^\+?[0-9]+$/.test(positional[0]) ? "duration" : "selector";
  const args = ["wait"];
  if (kind !== "duration" && timeout !== undefined) args.push("--timeout", String(BigInt(timeout)));
  if (flags["--state"] !== undefined) args.push("--state", flags["--state"]);
  const value = condition ? flags[condition] : kind === "duration" ? String(BigInt(positional[0])) : positional[0];
  return [...args, "--", kind, value];
}

function nativeScreenshot(values) {
  let full = false;
  let format;
  let quality;
  let annotate = false;
  const positional = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (["--full", "-f"].includes(value)) full = true;
    else if (value === "--screenshot-format") {
      if (format !== undefined || values[index + 1] === undefined) throw new Error("browser_exec_command_invalid");
      format = values[++index];
    } else if (value === "--screenshot-quality") {
      if (quality !== undefined || values[index + 1] === undefined) throw new Error("browser_exec_command_invalid");
      quality = values[++index];
    } else if (value === "--annotate") annotate = true;
    else if (value.startsWith("-")) throw new Error("browser_exec_command_unsupported");
    else positional.push(value);
  }
  if (positional.length > 2) throw new Error("browser_exec_command_invalid");
  let [element, output] = positional;
  if (positional.length === 1) {
    const relative = element.startsWith("./") || element.startsWith("../");
    const selector = !relative && [".", "#", "@"].some((prefix) => element.startsWith(prefix));
    const path = relative || element.includes("/") || /\.(png|jpg|jpeg|webp)$/.test(element);
    if (!selector && path) { output = element; element = undefined; }
  }
  return [full ? "full-screenshot" : "screenshot", ...(format === undefined ? [] : ["--format", format]), ...(quality === undefined ? [] : ["--quality", quality]), ...(annotate ? ["--annotate"] : []), ...(element === undefined ? [] : ["--element", element]), ...(output === undefined ? [] : ["--output", output])];
}

export function normalizeBrowserExec(options) {
  if (options.positional[0] !== "exec") {
    if (options.execCommand !== undefined) throw new Error("browser_command_invalid");
    return;
  }
  if (options.positional.length > 2 || Object.keys(options).some((key) => !["positional", "execCommand", ...routing].includes(key))) throw new Error("browser_command_invalid");
  const outer = Object.fromEntries(routing.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]));
  if (options.positional.length === 2) {
    if (outer.resource !== undefined) throw new Error("browser_command_invalid");
    outer.resource = options.positional[1];
  }
  if (outer.resource === undefined) outer.defaultResource = true;
  const args = nativeArguments(commandWords(options.execCommand));
  const inner = parseBrowserArguments(["--resource", "exec:target", ...args], { nativeValues: true });
  // Only the parsed tab reference may supply a page. Native routing flags in
  // other commands still cannot replace the outer caller's selection.
  if (args.length === 4 && args[0] === "tab" && ["switch", "close"].includes(args[1]) && args[2] === "--page") {
    if (outer.page !== undefined && outer.page !== inner.page) throw new Error("browser_tab_target_mismatch");
    outer.page = inner.page;
    delete inner.page;
  }
  if (inner.resource !== "exec:target" || inner.execCommand !== undefined
      || routing.some((key) => key !== "resource" && inner[key] !== undefined)) throw new Error("browser_command_invalid");
  delete inner.resource;
  for (const key of Object.keys(options)) delete options[key];
  Object.assign(options, inner, outer);
}
