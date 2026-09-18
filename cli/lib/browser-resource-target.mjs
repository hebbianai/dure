import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { parseBrowserWorkspaceCatalogTarget, browserWorkspaceSelectionResult } from "./contracts/browser-workspace-target.mjs";

/** Resolve omitted resource arguments against the selected backend's shared Browser. */
export function browserResourceSelection(options) {
  const all = options.all === true;
  if (options.defaultResource && options.positional[0] === "use") throw new Error("browser_command_invalid");
  if (all && (options.positional.length !== 2 || options.positional[0] !== "tab" || !["list", "current"].includes(options.positional[1]) || options.resource !== undefined))
    throw new Error("browser_command_invalid");
  const scoped = options.defaultResource === true && !all;
  delete options.defaultResource;
  delete options.all;
  if (scoped) {
    if (options.resource !== undefined) throw new Error("browser_command_invalid");
    options.resource = "browser:pending";
  }
  return { scoped, all };
}

export function browserCatalogResource(catalog) {
  if (!catalog || !isDureDomainIdV1(catalog.workspace_id) || !Array.isArray(catalog.resources)) throw new Error("browser_response_invalid");
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

export async function selectBrowserResource(request, resourceId, operationId) {
  const resource = (await request({ kind: "control_state", resource_id: resourceId }))?.result?.resource;
  if (!resource || resource.resource_id !== resourceId || !["resource_id", "generation", "workspace_id"].every((key) => isDureDomainIdV1(resource[key]))) throw new Error("browser_response_invalid");
  const catalog = (await request({ kind: "list" }))?.result;
  const expected = parseBrowserWorkspaceCatalogTarget(catalog);
  if (!expected || !catalog.resources.some((row) => ["resource_id", "generation", "workspace_id"].every((key) => row.resource[key] === resource[key]))) throw new Error("browser_response_invalid");
  const result = await request({ kind: "select_resource", resource, expected, operation_id: operationId });
  const target = browserWorkspaceSelectionResult(expected, resource, result?.result?.target);
  if (!target) throw new Error("browser_response_invalid");
  return { ...result, result: { target } };
}

/** A later lookup cannot replace the complete identity selected from List. */
export function assertBrowserResource(selected, kind, response) {
  if (!selected || !["observe", "control_state", "dialog_state"].includes(kind)) return;
  const observed = kind === "control_state" ? response?.result?.resource : response?.result?.control?.resource;
  if (!["resource_id", "generation", "workspace_id"].every((key) => observed?.[key] === selected[key])) throw new Error("browser_resource_mismatch");
}
