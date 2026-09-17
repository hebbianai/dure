import { browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";
import { assertBrowserWorkspaceResource } from "./browser-workspace-target.mjs";
import { parseBrowserWorkspaceCatalogTarget } from "./contracts/browser-workspace-target.mjs";
import { parseBrowserWorkspacePage } from "./contracts/browser-workspaces.mjs";
import { parseBrowserProfiles } from "./contracts/browser-profiles.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

export function browserTabLabel(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,159}$/.test(value)) throw new Error("browser_tab_label_invalid");
  return value;
}

export function browserTabWithLabel(view, label) {
  const tab = browserTabRows(view).find(row => row.label === label);
  if (!tab) throw new Error("browser_tab_label_missing");
  return tab;
}

/** Tab projections retain the Host's per-resource current page. */
export function browserTabRows(view) {
  const resource = view?.control?.resource;
  if (!resource || !["resource_id", "generation", "workspace_id"].every((key) => isDureDomainIdV1(resource[key]))
      || !Array.isArray(view.pages)) throw new Error("browser_response_invalid");
  const current = view.control.current_page == null ? undefined : browserCurrentPage(view.control);
  const ids = new Set();
  const labels = new Set();
  const tabs = view.pages.map((row) => {
    const page = browserCurrentPage({ resource, current_page: row?.page });
    if (ids.has(page.page_id)) throw new Error("browser_response_invalid");
    ids.add(page.page_id);
    if (row.label !== undefined) {
      try { browserTabLabel(row.label); } catch { throw new Error("browser_response_invalid"); }
      if (labels.has(row.label)) throw new Error("browser_response_invalid");
      labels.add(row.label);
    }
    return { ...row, active: !!current && sameBrowserPage(page, current) };
  });
  if (current && !tabs.some((row) => row.active)) throw new Error("browser_response_invalid");
  return tabs;
}

/** Traverse existing catalogs without selecting a workspace, resource or page. */
export async function allBrowserTabs(request) {
  const tabs = [];
  const resources = new Set();
  let after;
  do {
    const response = await request({ kind: "workspaces", ...(after === undefined ? {} : { after }) });
    const page = parseBrowserWorkspacePage(response?.result, after);
    if (!page) throw new Error("browser_response_invalid");
    for (const workspace of page.workspaces) {
      const catalog = (await request({ kind: "list", workspace_id: workspace.workspace_id }))?.result;
      const selection = parseBrowserWorkspaceCatalogTarget(catalog);
      if (!selection || selection.workspace_id !== workspace.workspace_id) throw new Error("browser_response_invalid");
      for (const row of catalog.resources) {
        const resource = row.resource;
        if (resources.has(resource.resource_id)) throw new Error("browser_response_invalid");
        resources.add(resource.resource_id);
        const observation = await request({ kind: "observe", resource_id: resource.resource_id });
        assertBrowserWorkspaceResource(resource, "observe", observation);
        const error = observation?.result?.observation_error;
        if (error !== undefined) throw new Error(typeof error === "string" && /^browser_[a-z0-9_]+$/.test(error) ? error : "browser_response_invalid");
        tabs.push(...browserTabRows(observation?.result));
      }
    }
    after = page.next;
  } while (after !== null);
  return tabs;
}

/** Saved labels decorate exact profile identities; they never choose a profile. */
export async function browserTabsWithProfiles(request, tabs) {
  const profiles = parseBrowserProfiles((await request({ kind: "profile_list" }))?.result);
  if (!profiles) throw new Error("browser_response_invalid");
  const byId = new Map(profiles.map((row) => [row.profile.profileId, row.profile]));
  return tabs.map((row) => {
    const profile = byId.get(row.profile_id);
    if (!profile) throw new Error("browser_profile_missing");
    return { ...row, profile_label: profile.label };
  });
}
