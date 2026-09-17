export interface FileTarget {
  path: string;
  source: "local" | "ssh";
  hostId?: string;
  sessionId?: string;
}

/** Parse file coordinates once at an untyped pane or persistence boundary. */
export function fileTargetFromParams(value: unknown): FileTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { path, source, hostId, sessionId } = value as Record<string, unknown>;
  if (typeof path !== "string" || !path) return undefined;
  if (source !== "local" && source !== "ssh") return undefined;
  if (hostId !== undefined && (typeof hostId !== "string" || !hostId)) return undefined;
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) return undefined;
  return {
    path,
    source,
    ...(hostId === undefined ? {} : { hostId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

export function fileTargetFromPane(pane: {
  component?: string;
  params?: unknown;
}): FileTarget | undefined {
  return pane.component === "fileviewer" ? fileTargetFromParams(pane.params) : undefined;
}

/** This key is persisted; session reconnection does not change document identity. */
export function fileDraftKey(target: FileTarget): string {
  return `${target.source}:${target.hostId ?? ""}:${target.path}`;
}
