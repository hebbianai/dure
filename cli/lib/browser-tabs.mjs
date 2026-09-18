import { browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";
import { assertBrowserResource } from "./browser-resource-target.mjs";
import { parseBrowserWorkspaceCatalogTarget } from "./contracts/browser-workspace-target.mjs";
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

/** Read every existing Browser on this backend without changing selection. */
export async function allBrowserTabs(request) {
  const catalog = (await request({ kind: "list" }))?.result;
  if (!parseBrowserWorkspaceCatalogTarget(catalog)) throw new Error("browser_response_invalid");
  const tabs = [];
  for (const row of catalog.resources) {
    const resource = row.resource;
    const observation = await request({ kind: "observe", resource_id: resource.resource_id });
    assertBrowserResource(resource, "observe", observation);
    const error = observation?.result?.observation_error;
    if (error !== undefined) throw new Error(typeof error === "string" && /^browser_[a-z0-9_]+$/.test(error) ? error : "browser_response_invalid");
    tabs.push(...browserTabRows(observation?.result));
  }
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
