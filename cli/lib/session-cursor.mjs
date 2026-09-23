import { boundedString, record } from "./session-runtime-projection.mjs";

export const SESSION_PAGINATION_CAPABILITY = "sessions.list.pagination_v1";
export const HMUX_SESSION_PAGINATION_CAPABILITY = "bounded_session_catalog_pagination_v1";

export function parseSessionCursor(cursor) {
  if (cursor === undefined) return undefined;
  if (cursor === "start") return { after: null };
  if (typeof cursor !== "string" || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("Invalid session cursor");
  }
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!record(value) || Object.keys(value).length !== 3 || value.schemaVersion !== 1 ||
    !boundedString(value.workspaceId) || !boundedString(value.sessionId)) {
    throw new Error("Invalid session cursor");
  }
  return { after: { workspaceId: value.workspaceId, sessionId: value.sessionId } };
}

export function sessionCursor(session) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, workspaceId: session.workspaceId, sessionId: session.sessionId,
  })).toString("base64url");
}

export function compareSessionIdentities(left, right) {
  // Match Rust String's byte ordering, including non-ASCII identifiers.
  return Buffer.compare(Buffer.from(left.workspaceId), Buffer.from(right.workspaceId)) ||
    Buffer.compare(Buffer.from(left.sessionId), Buffer.from(right.sessionId));
}
