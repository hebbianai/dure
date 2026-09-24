export const AGENT_STOP_HELP = `Usage:
  dure stop <agent-name-or-id> [--target-panel-id ID] --yes [--json]
  dure hmux stop --name <agent-name-or-id> [--target-panel-id ID] --yes [--json]

Stop one Agent and remove its registration and panes. Workspaces, worktrees and
conversation history are preserved. Use project/name for ambiguous names.
Requires the Dure app selected by DURE_APP_CHANNEL; the app routes each Agent to
its owning backend. --backend is not supported by this client-scoped command.
Omit --yes only in an interactive terminal to confirm there.
Uses dispatch.stop for backend-owned Agents; no /exit or terminal key injection.
After an uncertain response, retry the same Agent ID to reconcile the recorded
stop before cleanup. A successful receipt confirms cleanup; a failure does not.
JSON uses dure.agent-stop/v1. Exit 0 means cleaned; exit 1 means failed.`;

export function parseAgentStopCommand(args) {
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    return { help: true };
  }
  const options = { rest: ["stop"] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      options.rest.push(...args.slice(index + 1));
      break;
    }
    if (["--yes", "--json"].includes(arg)) {
      const key = arg.slice(2);
      if (options[key]) throw new Error(AGENT_STOP_HELP);
      options[key] = true;
    } else if (["--name", "--target-panel-id"].includes(arg)) {
      const key = arg === "--name" ? "name" : "targetPanelId";
      const value = args[++index];
      if (options[key] !== undefined || !value?.trim() || value.startsWith("--")) throw new Error(AGENT_STOP_HELP);
      options[key] = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unsupported stop option: ${arg}\n${AGENT_STOP_HELP}`);
    } else options.rest.push(arg);
  }
  if (options.rest.length !== (options.name ? 1 : 2) || !(options.name ?? options.rest[1])?.trim()) {
    throw new Error(AGENT_STOP_HELP);
  }
  return options;
}

export function agentStopReport(receipt, httpOk) {
  const valid = receipt && typeof receipt === "object" && typeof receipt.ok === "boolean" &&
    (!receipt.ok || receipt.dispatchStop || receipt.stop || receipt.cleanup);
  return {
    ...(valid ? receipt : { error: { code: "agent_stop_response_invalid", message: "The app did not return a stop receipt. Inspect the Agent before retrying." } }),
    apiVersion: "dure.agent-stop/v1", ok: Boolean(httpOk && valid && receipt.ok),
  };
}

export function formatAgentStopReport(report, name) {
  if (!report.ok) return `${report.error?.code ?? "agent_stop_failed"}: ${report.error?.message ?? "Agent cleanup failed"}`;
  const label = report.agent?.name ?? name;
  if (report.dispatchStop) return `${label} stopped and removed (${report.dispatchStop.status})${report.dispatchStop.workspaceDisposition === "preserve" ? "; workspace preserved" : ""}`;
  if (report.cleanup) return `${label} exited registration cleaned (${report.cleanup.sourceState || report.cleanup.reason}, ${report.cleanup.sessionId}, ${report.cleanup.workspaceId})`;
  return `${label} provider stopped (${report.stop.outcome}, ${report.stop.sessionId}, ${report.stop.workspaceId})`;
}
