import fs from "node:fs";
import os from "node:os";
import { OrchestrationCommandError } from "./orchestration-command.mjs";
import {
  ORCHESTRATION_INTEGRATION_PROVIDERS,
  orchestrationIntegrationReceiptPaths,
} from "./orchestration-integration.mjs";
import { handleMcpRequest } from "./orchestration-mcp-server.mjs";

const ORCHESTRATION_TOOL_USAGE =
  "usage: dure orchestration tool <tool-name> ['<arguments-json>'] [--provider claude|codex] [--json]";

function parseToolArguments(source) {
  if (source === undefined) return {};
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    value = undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OrchestrationCommandError(
      "orchestration_tool_arguments_invalid",
      "tool arguments must be one JSON object, the same arguments the MCP tool takes (for example '{\"body\": {...}}')",
    );
  }
  return value;
}

/** The install receipt of the provider this shell runs under. A provider's own
 * MCP server reads the same receipt, so the session identity and enrollment
 * match what the MCP tool would have used. */
export function resolveOrchestrationToolReceipt({
  provider,
  environment,
  homeDirectory = os.homedir(),
  workspaceRoot = process.cwd(),
  exists = fs.existsSync,
}) {
  if (provider !== undefined && !ORCHESTRATION_INTEGRATION_PROVIDERS.includes(provider)) {
    throw new OrchestrationCommandError(
      "orchestration_tool_provider_invalid",
      `--provider must be one of ${ORCHESTRATION_INTEGRATION_PROVIDERS.join(", ")}`,
    );
  }
  const candidates =
    provider !== undefined
      ? [provider]
      : environment.CLAUDECODE === "1"
        ? ["claude"]
        : ORCHESTRATION_INTEGRATION_PROVIDERS;
  const installed = candidates.flatMap((name) => {
    const receiptPath = orchestrationIntegrationReceiptPaths({
      provider: name,
      homeDirectory,
      workspaceRoot,
    }).find((candidate) => exists(candidate));
    return receiptPath ? [{ provider: name, receiptPath }] : [];
  });
  if (installed.length === 1) return installed[0];
  if (installed.length === 0) {
    throw new OrchestrationCommandError(
      "orchestration_integration_missing",
      `no dure-orchestration integration is installed for ${candidates.join(" or ")}; run dure integration install`,
    );
  }
  throw new OrchestrationCommandError(
    "orchestration_tool_provider_ambiguous",
    `integrations for ${installed.map((entry) => entry.provider).join(" and ")} are installed; pass --provider with the provider this agent runs under`,
  );
}

function toolOutput(result) {
  const [first, ...rest] = Array.isArray(result?.content) ? result.content : [];
  let value = result?.structuredContent ?? null;
  if (typeof first?.text === "string") {
    try {
      value = JSON.parse(first.text);
    } catch {
      value = first.text;
    }
  }
  const notices = rest
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
  return { value, notices, isError: result?.isError === true };
}

/** Run one dure-orchestration MCP tool from a shell, through the same handler
 * and with the same arguments as the MCP server. This is the fallback when the
 * provider could not connect the MCP server: context resolution, fence
 * refresh and cursor checkpoints behave exactly as they do over MCP. */
export async function runOrchestrationToolFromCli({
  arguments_,
  provider,
  environment = process.env,
  homeDirectory,
  workspaceRoot,
  exists,
  json = false,
  output = (source) => process.stdout.write(source),
  notice = (source) => process.stderr.write(source),
  handle = handleMcpRequest,
} = {}) {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length < 1 ||
    arguments_.length > 2 ||
    typeof arguments_[0] !== "string" ||
    arguments_[0].length === 0
  ) {
    throw new OrchestrationCommandError("orchestration_usage_invalid", ORCHESTRATION_TOOL_USAGE);
  }
  const [name, source] = arguments_;
  const toolArguments = parseToolArguments(source);
  const { tools } = await handle({ jsonrpc: "2.0", method: "tools/list" });
  if (!tools.some((tool) => tool.name === name)) {
    throw new OrchestrationCommandError(
      "orchestration_tool_unknown",
      `unknown tool ${name}; available tools: ${tools.map((tool) => tool.name).join(", ")}`,
    );
  }
  const { receiptPath } = resolveOrchestrationToolReceipt({
    provider,
    environment,
    homeDirectory,
    workspaceRoot,
    exists,
  });
  const result = await handle(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: toolArguments },
    },
    environment,
    { receiptPath },
  );
  const { value, notices, isError } = toolOutput(result);
  for (const text of notices) notice(`${text}\n`);
  output(`${JSON.stringify(value, null, json ? 0 : 2)}\n`);
  return { value, isError };
}
