import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { parseBrowserWorkspaceCatalogTarget, browserWorkspaceSelectionResult } from "./contracts/browser-workspace-target.mjs";

/** Consume workspace selectors before parsing each command's own arguments. */
export function browserWorkspaceSelection(options) {
  const catalogCommand = ["create", "list"].includes(options.positional[0]);
  const specified = options.workspace !== undefined || options.worktree !== undefined;
  if (specified && options.positional[0] === "use") throw new Error("browser_command_invalid");
  if (options.workspace !== undefined && options.worktree !== undefined) throw new Error("browser_command_invalid");
  if (options.worktree === "all") {
    if (options.positional.length !== 2 || options.positional[0] !== "tab" || !["list", "current"].includes(options.positional[1])
        || options.resource !== undefined) throw new Error("browser_command_invalid");
    delete options.worktree;
    return { requested: false, scoped: false, all: true };
  }
  let target;
  if (options.workspace !== undefined) {
    if (!isDureDomainIdV1(options.workspace)) throw new Error("browser_command_invalid");
    target = { workspace_id: options.workspace };
  } else if (options.worktree !== undefined && !["current", "active"].includes(options.worktree)) {
    if (options.worktree.startsWith("id:") && isDureDomainIdV1(options.worktree.slice(3))) {
      target = { workspace_id: options.worktree.slice(3) };
    } else if (options.worktree.startsWith("path:") && options.worktree.length > 5 && Buffer.byteLength(options.worktree.slice(5), "utf8") <= 4096 && !options.worktree.includes("\0")) {
      target = { workspace_path: options.worktree.slice(5) };
    } else throw new Error("browser_command_invalid");
  }
  delete options.workspace;
  delete options.worktree;
  const scoped = specified && !catalogCommand;
  if (scoped) {
    if (options.resource !== undefined) throw new Error("browser_command_invalid");
    // An explicit workspace selector makes the missing-resource grammar
    // unambiguous, even when a valid opaque resource ID is also a subcommand.
    // This parsing placeholder is replaced before any resource request.
    options.resource = "workspace:pending";
  }
  return { requested: catalogCommand || scoped, scoped, target };
}

export function resolveBrowserWorkspaceTarget(selection, profile, cwd) {
  if (!selection.requested || selection.target) return selection.target;
  if (profile.transport?.kind !== "local") throw new Error("browser_workspace_required");
  const path = cwd ?? process.cwd();
  if (typeof path !== "string" || !path || Buffer.byteLength(path, "utf8") > 4096 || path.includes("\0")) throw new Error("browser_workspace_path_invalid");
  return { workspace_path: path };
}

export function browserWorkspaceResource(catalog, target) {
  if (!catalog || !isDureDomainIdV1(catalog.workspace_id) || !Array.isArray(catalog.resources)
      || (target.workspace_id !== undefined && catalog.workspace_id !== target.workspace_id)) throw new Error("browser_response_invalid");
  const ids = new Set();
  for (const row of catalog.resources) {
    const resource = row?.resource;
    if (!resource || !["resource_id", "generation", "workspace_id"].every((key) => isDureDomainIdV1(resource[key]))
        || resource.workspace_id !== catalog.workspace_id || ids.has(resource.resource_id)) throw new Error("browser_response_invalid");
    ids.add(resource.resource_id);
  }
  if (Object.hasOwn(catalog, "target")) {
    const selected = parseBrowserWorkspaceCatalogTarget(catalog);
    if (!selected) throw new Error("browser_response_invalid");
    if (selected.current_resource === null) throw new Error("browser_resource_missing");
    return selected.current_resource;
  }
  if (catalog.resources.length === 0) throw new Error("browser_resource_missing");
  if (catalog.resources.length !== 1) throw new Error("browser_resource_ambiguous");
  const { resource_id, generation, workspace_id } = catalog.resources[0].resource;
  return { resource_id, generation, workspace_id };
}

export async function selectBrowserWorkspaceResource(request, resourceId, operationId) {
  const resource = (await request({ kind: "control_state", resource_id: resourceId }))?.result?.resource;
  if (!resource || resource.resource_id !== resourceId || !["resource_id", "generation", "workspace_id"].every((key) => isDureDomainIdV1(resource[key]))) throw new Error("browser_response_invalid");
  const catalog = (await request({ kind: "list", workspace_id: resource.workspace_id }))?.result;
  const expected = parseBrowserWorkspaceCatalogTarget(catalog);
  if (!expected || !catalog.resources.some((row) => ["resource_id", "generation", "workspace_id"].every((key) => row.resource[key] === resource[key]))) throw new Error("browser_response_invalid");
  const result = await request({ kind: "select_resource", resource, expected, operation_id: operationId });
  const target = browserWorkspaceSelectionResult(expected, resource, result?.result?.target);
  if (!target) throw new Error("browser_response_invalid");
  return { ...result, result: { target } };
}

/** A later lookup cannot replace the complete identity selected from List. */
export function assertBrowserWorkspaceResource(selected, kind, response) {
  if (!selected || !["observe", "control_state", "dialog_state"].includes(kind)) return;
  const observed = kind === "control_state" ? response?.result?.resource : response?.result?.control?.resource;
  if (!["resource_id", "generation", "workspace_id"].every((key) => observed?.[key] === selected[key])) throw new Error("browser_resource_mismatch");
}
