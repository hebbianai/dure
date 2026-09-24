import { runBoundedCommand } from "./bounded-command.mjs";
import { MANAGED_REHOST_SOURCE_GUIDANCE, managedRehostIdentity, matchesManagedRehostSource } from "./managed-rehost-identity.mjs";

const commands = {
  start: "managed-rehost-start",
  retry: "managed-rehost-reconcile",
};
const help = (action) =>
  `dure hmux rehost ${action} ${action === "retry" ? "[<original-session-id> --workspace ID]" : "<original-session-id> --workspace ID"} --operation-id ID --confirm-restart [--json]`;

/** Native admission owns the source generation and every journaled replacement input. */
export async function collectManagedRehostCommand({
  action,
  sessionId,
  workspaceId,
  operationId,
  confirmRestart,
  command,
  runtime = process.env.DURE_HMUX_RUNTIME_BIN?.trim(),
  run = runBoundedCommand,
}) {
  const failure = (code, message) => ({
    ok: false,
    operationId,
    error: { code, message },
  });
  const identity = managedRehostIdentity({ sessionId, workspaceId, operationId });
  if (
    !Object.hasOwn(commands, action) ||
    !identity || (action === "start" && !identity.source)
  ) {
    return failure(`rehost_${action}_request_invalid`, help(action));
  }
  const response = await run(
    [
      command,
      commands[action],
      ...identity.args,
      ...(confirmRestart ? ["--confirm-restart"] : []),
      ...(runtime ? ["--runtime", runtime] : []),
      "--json",
    ],
    { timeoutMs: 45_000, maxCaptureBytes: 1024 * 1024 },
  );
  const sourceArgs = identity.source ? `${sessionId} --workspace ${workspaceId} ` : "";
  const inspect = `Inspect the same operation with: dure hmux rehost status ${sourceArgs}--operation-id ${operationId}${identity.source ? "" : `\n${MANAGED_REHOST_SOURCE_GUIDANCE}`}`;
  if (response.kind !== "success") {
    return failure(
      `rehost_${action}_${response.kind}`,
      `Operation outcome is unknown; no additional operation was submitted. ${inspect}\n${(response.stderr || response.message || "").trim()}`,
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(response.stdout);
  } catch {
    /* Report an unknown outcome below. */
  }
  // Native receipt decoding owns lifecycle and generation validity. This boundary only
  // correlates the native command's envelope with the exact request we sent.
  if (
    !receipt ||
    receipt.operationId !== operationId ||
    !matchesManagedRehostSource(identity, receipt.sourceStopReceipt) ||
    typeof receipt.replacementReceipt?.sessionId !== "string" ||
    typeof receipt.replayed !== "boolean" ||
    !(
      (receipt.schema === "hmux-managed-rehost-v1" &&
        receipt.schemaVersion === 1) ||
      (receipt.schema === "managed-session-replacement-receipt-v2" &&
        receipt.schemaVersion === 2)
    )
  ) {
    return failure(
      `rehost_${action}_response_invalid`,
      `Operation outcome is unknown; Hmux did not return this exact receipt. ${inspect}`,
    );
  }
  return { ok: true, operationId, receipt };
}

export async function runManagedRehostCommand(opts, command) {
  const action = opts.rest[1];
  const unsupported =
    ![2, 3].includes(opts.rest.length) ||
    opts.backend !== undefined ||
    opts.fresh ||
    opts.permissionMode !== undefined ||
    opts.existingSessionId !== undefined ||
    opts.conversationId !== undefined ||
    Boolean(opts.name) ||
    opts.fromSession !== undefined ||
    opts.credentialReference !== undefined ||
    opts.credentialGeneration !== undefined ||
    opts.targetPanelId !== undefined ||
    opts.provider !== undefined ||
    opts.cwd !== undefined;
  const report = unsupported
    ? {
        ok: false,
        error: {
          code: `rehost_${action}_request_invalid`,
          message: `${help(action)}\nThe local native broker owns the target. Routing, pane, and replacement options are not supported.`,
        },
      }
    : await collectManagedRehostCommand({
        action,
        sessionId: opts.rest[2],
        workspaceId: opts.workspace,
        operationId: opts.operationId,
        confirmRestart: opts.confirmRestart,
        command,
      });
  const output = opts.json
    ? JSON.stringify(report.ok ? report.receipt : report)
    : report.ok
      ? `${report.operationId}: completed (${report.receipt.sourceStopReceipt.sessionId} -> ${report.receipt.replacementReceipt.sessionId}, replayed=${report.receipt.replayed})\nRecorded rehost completion; no pane was changed.`
      : `${report.error.code}: ${report.error.message}`;
  (report.ok ? process.stdout : process.stderr).write(`${output}\n`);
  if (!report.ok) process.exitCode = 1;
}
