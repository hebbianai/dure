import { isDureDomainIdV1 } from "./protocol-identity.mjs";

export function parseBrowserWorkspacePage(value, after) {
  if (
    value === null || typeof value !== "object" ||
    !Array.isArray(value.workspaces) || value.workspaces.length > 128 ||
    (after !== undefined && !isDureDomainIdV1(after)) ||
    (value.next !== null && !isDureDomainIdV1(value.next))
  ) return null;

  let previous = after;
  const workspaces = [];
  for (const row of value.workspaces) {
    if (
      row === null || typeof row !== "object" ||
      !isDureDomainIdV1(row.workspace_id) ||
      typeof row.project_name !== "string" || typeof row.root_path !== "string" ||
      (previous !== undefined && row.workspace_id <= previous)
    ) return null;
    workspaces.push({
      workspace_id: row.workspace_id,
      project_name: row.project_name,
      root_path: row.root_path,
    });
    previous = row.workspace_id;
  }
  if (value.next !== null && (workspaces.length === 0 || value.next !== previous)) return null;
  return { workspaces, next: value.next };
}
