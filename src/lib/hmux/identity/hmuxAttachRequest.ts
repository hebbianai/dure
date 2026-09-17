export type HmuxAttachTarget =
  | { kind: "name"; name: string }
  | { kind: "exact"; sessionId: string; workspaceId: string };

export class HmuxAttachRequestError extends Error {
  readonly code = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "HmuxAttachRequestError";
  }
}

function requestString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * Parse the public IDE attach request without interpreting opaque discovery
 * paths. A caller chooses either one exact human name or the canonical
 * session/workspace pair returned by the backend.
 */
export function hmuxAttachTargetFromRequest(
  params: Record<string, unknown>,
): HmuxAttachTarget {
  const name = requestString(params.name);
  const sessionId = requestString(params.sessionId);
  const workspaceId = requestString(params.workspaceId);
  const hasExactIdentity = Boolean(sessionId || workspaceId);

  if (name && hasExactIdentity) {
    throw new HmuxAttachRequestError(
      "name cannot be combined with sessionId or workspaceId",
    );
  }
  if (name) return { kind: "name", name };
  if (sessionId && workspaceId) {
    return { kind: "exact", sessionId, workspaceId };
  }
  throw new HmuxAttachRequestError(
    "name or both sessionId and workspaceId are required",
  );
}
