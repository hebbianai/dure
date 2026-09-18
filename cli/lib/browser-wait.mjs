import { target } from "./browser-reference.mjs";
import { BrowserCommandError } from "./browser-command-error.mjs";

function milliseconds(value) {
  if (!/^(0|[1-9][0-9]{0,5})$/.test(value) || Number(value) > 120_000) throw new BrowserCommandError("browser_wait_timeout_invalid", "Wait duration must be an integer from 0 to 120000 milliseconds.", "Use --timeout MS for a condition, or wait RESOURCE duration MS for a fixed wait.");
  return Number(value);
}

export function browserWait(values, options) {
  if (values.length !== 2) throw new Error("browser_wait_invalid");
  const [kind, value] = values;
  const timeout_ms = milliseconds(kind === "duration" ? value : (options.timeout ?? "10000"));
  if (options.state !== undefined && kind !== "selector") throw new Error("browser_wait_invalid");
  if (kind === "duration" && options.timeout !== undefined) throw new Error("browser_wait_invalid");
  let condition;
  if (kind === "selector") {
    if (options.state !== undefined && !["visible", "hidden", "attached", "detached"].includes(options.state)) throw new BrowserCommandError("browser_wait_state_invalid", "Unknown selector wait state.", "Use --state visible, hidden, attached or detached.", "--state");
    const element = target(value);
    if (element.kind !== "css") throw new Error("browser_wait_requires_selector");
    condition = { kind, target: element, state: options.state ?? "visible" };
  } else if (kind === "text") condition = { kind, text: value };
  else if (kind === "url") condition = { kind, pattern: value };
  else if (kind === "load") {
    if (!["load", "domcontentloaded", "networkidle"].includes(value)) throw new BrowserCommandError("browser_wait_load_invalid", "Unknown page load state.", "Use load, domcontentloaded or networkidle for the load condition.");
    condition = { kind, state: value };
  }
  else if (kind === "duration") condition = { kind };
  else if (kind === "function") return { function: { expression: value, timeout_ms }, deadlineMs: timeout_ms + 45_000 };
  else throw new Error("browser_wait_invalid");
  return { wait: { condition, timeout_ms }, deadlineMs: timeout_ms + 45_000 };
}
