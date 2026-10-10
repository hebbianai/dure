import { parseArgs } from "node:util";
import { runBoundedCommand } from "./bounded-command.mjs";
import { matchingAgents } from "./client-registry.mjs";
import { resolveLocalManagedInputBinding } from "./exact-session-input.mjs";
import { controllableHmuxBinding, managedInputFenceJson } from "./managed-input-binding.mjs";
import { supportsHmuxCapability } from "./runtime-diagnostics.mjs";

const HELP = `dure send-keys — Send semantic keys to a local managed agent

Usage: dure send-keys <name|project/name|session-id> <key...> [--json]
       dure send-keys <session-id> <key...> --workspace ID [--json]

Examples:
  dure send-keys worker C-c
  dure send-keys worker Up Enter --json
  dure send-keys worker Ctrl+Left Shift+Tab
  dure send-keys session-1 Down Enter --workspace workspace-1 --json

Keys: Enter, Tab, Escape (Esc), Backspace, Space, Up, Down, Left, Right,
      Home, End, PageUp, PageDown, Insert, Delete, F1..F12, ASCII letters/digits.
Modifiers: Ctrl+ / C-, Alt+ / M-, Shift+ / S- (combinations allowed).
Use dure send for literal text, files, and stdin; no Enter is added here.

Requires a local managed terminal and a current Hmux CLI. Headless Runs do not
need a pane or client registration: use their exact Session ID and --workspace.
--workspace selects an exact Session directly, independent of registry names.
SSH, structured chat input, and standalone terminals are not supported.
The Host encodes keys using the terminal's current keyboard mode.
Up to 64 ordered keys; this is not an atomic batch. JSON reports delivery only,
including a completed prefix on failure. Uncertain keys are never retried.
`;

function failure(code, message, deliveryState = "not_written") {
  return { ok: false, error: { code, message, deliveryState } };
}

function decode(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function validReceipt(payload, binding, count) {
  const receipt = payload?.receipt;
  if (payload?.schemaVersion !== 1 || payload.ok !== true ||
    payload.sessionId !== binding.sessionId || payload.workspaceId !== binding.workspaceId ||
    receipt?.terminalEpoch !== binding.stopFence.terminalEpoch ||
    !Array.isArray(receipt.keys) || receipt.keys.length !== count) return false;
  let previous;
  return receipt.keys.every((record) => {
    if (record?.state !== "written_to_pty" || typeof record.recordId !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(record.recordId)) return false;
    const id = BigInt(record.recordId);
    const valid = id <= 18_446_744_073_709_551_615n && (previous === undefined || id === previous + 1n);
    previous = id;
    return valid;
  });
}

async function sendKeys(args, { loadRegistry, hmuxCommand, channel }) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" }, workspace: { type: "string" } } });
  } catch (error) { return failure("invalid_arguments", error.message); }
  const [name, ...keys] = parsed.positionals;
  if (!name || keys.length < 1 || keys.length > 64 || parsed.values.workspace?.trim() === "") {
    return failure("invalid_arguments", "Specify one recipient and 1..64 keys. See dure send-keys --help.");
  }
  const workspaceId = parsed.values.workspace;
  const matches = workspaceId === undefined ? matchingAgents(loadRegistry(), name) : [];
  if (matches.length > 1) {
    return failure("target_not_unique", "Recipient matches multiple agents; use project/name or an exact Session ID with --workspace.");
  }
  const agent = matches[0];
  const executable = hmuxCommand();
  let binding;
  if (agent) binding = controllableHmuxBinding(agent);
  else {
    if (process.env.DURE_BACKEND_PROFILE?.trim()) {
      return failure("unsupported_target", "Exact Session keys require the local Hmux runtime; a backend profile is not supported.");
    }
    try {
      binding = await resolveLocalManagedInputBinding({sessionId:name, workspaceId, hmuxCommand:executable, channel});
    } catch (error) { return failure(error.code ?? "target_unavailable", error.message); }
  }
  const fence = managedInputFenceJson(binding);
  if (binding?.source !== "local" || !fence) {
    return failure("unsupported_target", "Named keys require a local managed terminal with a complete generation fence.");
  }
  const target = { ...(agent ? {agentId:agent.id} : {}), sessionId: binding.sessionId, workspaceId: binding.workspaceId };
  const probe = await runBoundedCommand([executable, "capabilities", "--json"], { timeoutMs: 2500 });
  if (probe.kind !== "success" || !supportsHmuxCapability(decode(probe.stdout), "semantic_key_input_v1")) {
    return { ...failure("capability_unavailable", "Hmux semantic_key_input_v1 is unavailable; update the channel runtime."), target };
  }
  const result = await runBoundedCommand([executable, "--json", "command-input",
    "--target", binding.sessionId, "--workspace", binding.workspaceId,
    "--expected-fence-json", fence, ...keys.flatMap((key) => ["--key", key])],
  { timeoutMs: 15_000 });
  const payload = decode(result.stdout);
  if (result.kind === "success" && validReceipt(payload, binding, keys.length)) {
    return { ok: true, target, receipt: payload.receipt };
  }
  if (payload?.schemaVersion === 1 && payload.ok === false && typeof payload.error?.code === "string") {
    return { ok: false, target, error: payload.error, ...(payload.receipt ? { receipt: payload.receipt } : {}) };
  }
  return { ...failure("delivery_outcome_unknown",
    "No valid final key receipt was returned. Inspect the target before sending again.", "outcome_unknown"), target };
}

export async function runSendKeysCommand(args, dependencies) {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const report = { apiVersion: "dure.send-keys/v1", ...await sendKeys(args, dependencies) };
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
  else if (report.ok) process.stdout.write(`Sent ${report.receipt.keys.length} key(s) · written_to_pty\n`);
  if (!report.ok) {
    process.stderr.write(`${report.error.code}: ${report.error.message} (${report.error.deliveryState})\n`);
    process.exitCode = 1;
  }
}
