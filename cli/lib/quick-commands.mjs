import { parseArgs } from "node:util";
import { requestAppControl } from "./app-control-client.mjs";
import { readUtf8Input } from "./text-input.mjs";

export const QUICK_COMMANDS_HELP = `dure quick-commands list [--json]
dure quick-commands put <id> --label <label> (--text <text> | --file <path>) [--append-enter] [--json]
dure quick-commands remove <id> [--json]

Manage saved text in the connected Dure app. Requires a running, updated app;
no macOS automation permission or agent session is needed.
put replaces only the exact ID. Text is preserved; Enter is opt-in on each put.
Saving never sends input or executes a prompt. Reuse the ID to avoid duplicates.`;

export async function runQuickCommands(args, loadDescriptor) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { label: { type: "string" }, text: { type: "string" }, file: { type: "string" },
      "append-enter": { type: "boolean" }, json: { type: "boolean" },
      help: { type: "boolean", short: "h" } } });
  if (values.help || positionals.length === 0 || positionals[0] === "help") return QUICK_COMMANDS_HELP;
  const [operation, id] = positionals;
  if (!(["list", "put", "remove"].includes(operation)) ||
      positionals.length !== (operation === "list" ? 1 : 2)) throw new Error(QUICK_COMMANDS_HELP);
  const hasText = values.text !== undefined;
  const hasFile = values.file !== undefined;
  if (operation !== "put" && (values.label !== undefined || hasText || hasFile || values["append-enter"])) {
    throw new Error("text, label and --append-enter are only valid with put");
  }
  let body = { operation, ...(id === undefined ? {} : { id }) };
  if (operation === "put") {
    if (!values.label || hasText === hasFile) throw new Error("put requires --label and exactly one of --text or --file");
    body = { operation, command: { id, label: values.label,
      text: hasFile ? readUtf8Input(values.file) : values.text,
      appendEnter: values["append-enter"] === true } };
  }
  if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) throw new Error("Quick Command request exceeds 64 KiB");
  const descriptor = loadDescriptor();
  if (!descriptor) throw new Error("Dure app is not running; Quick Commands belong to the connected app settings.");
  if (!Array.isArray(descriptor.capabilities) || !descriptor.capabilities.includes("quick_commands_v1")) throw new Error("Please update the running Dure app: it does not support Quick Commands through CLI yet.");
  const receipt = await requestAppControl({ descriptor, path: "/quick-commands", body });
  return JSON.stringify(receipt, null, values.json ? undefined : 2);
}
