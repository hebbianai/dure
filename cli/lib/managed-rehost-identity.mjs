export const MANAGED_REHOST_SOURCE_GUIDANCE =
  "If source lookup is unavailable, use the saved original target: dure hmux rehost status <original-session-id> --workspace <original-workspace-id> --operation-id <same-operation-id>. Do not resolve a new name or start another operation.";

/** Parse the CLI selection once. An omitted source is resolved only by the native journal. */
export function managedRehostIdentity({ sessionId, workspaceId, operationId }) {
  const present = (id) => typeof id === "string" && id.trim().length > 0;
  if (!present(operationId)) return null;
  if (sessionId === undefined && workspaceId === undefined) {
    return { operationId, source: null, args: ["--operation-id", operationId] };
  }
  if (!present(sessionId) || !present(workspaceId)) return null;
  return {
    operationId,
    source: { sessionId, workspaceId },
    args: ["--session", sessionId, "--workspace", workspaceId, "--operation-id", operationId],
  };
}

/** Correlate the native response with only the source the caller actually selected. */
export function matchesManagedRehostSource(identity, source) {
  return typeof source?.sessionId === "string" && source.sessionId.length > 0 &&
    typeof source.workspaceId === "string" && source.workspaceId.length > 0 &&
    (identity.source === null ||
      (source.sessionId === identity.source.sessionId && source.workspaceId === identity.source.workspaceId));
}
