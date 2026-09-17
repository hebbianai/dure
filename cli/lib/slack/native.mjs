import { slackKey } from "./event.mjs";

/** Runtime selection, not the existence of a retained chat history, owns input. */
export function nativeSlackTarget(snapshot, agentId) {
  if (snapshot?.state !== "stable" || snapshot.receipt?.agentId !== agentId) {
    throw Object.assign(new Error("The task runtime is changing or unavailable."), { code: "slack_task_runtime_unavailable" });
  }
  const receipt = snapshot.receipt;
  if (receipt.authority?.interactionProfile === "structured_protocol") return null;
  const authority = receipt.authority?.authority;
  if (receipt.authority?.interactionProfile !== "native_cli" || authority?.binding?.agentId !== agentId ||
      typeof authority.terminalEpoch !== "string" || !Number.isSafeInteger(receipt.selectionRevision)) {
    throw Object.assign(new Error("The native task identity is unavailable."), { code: "slack_task_runtime_unavailable" });
  }
  return { schemaVersion: 1, agentId, expectedSelectionRevision: receipt.selectionRevision,
    expectedTerminalEpoch: authority.terminalEpoch };
}

export function nativeSlackPage(snapshot, target, after) {
  const cursor = snapshot?.cursor;
  if (snapshot?.schemaVersion !== 1 || cursor?.terminalEpoch !== target.expectedTerminalEpoch ||
      !/^(0|[1-9][0-9]*)$/.test(cursor?.turnCompletedCount ?? "") ||
      (snapshot.finalResponse !== null && typeof snapshot.finalResponse !== "string")) {
    throw Object.assign(new Error("The native task response is invalid."), { code: "slack_task_response_invalid" });
  }
  const same = JSON.stringify(cursor) === JSON.stringify(after);
  const text = snapshot.finalResponse;
  return {
    native: { target, cursor, publishable: same || Boolean(text) },
    rows: !same && text ? [{ item: { itemId: slackKey(target.agentId, cursor.terminalEpoch, cursor.turnCompletedCount),
      body: { type: "message", role: "assistant", markdown: text } } }] : [],
    goal: null,
  };
}
