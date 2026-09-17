const SIDEBAR_TABS = [
  "spaces",
  "tag",
  "recovery",
  "files",
  "search",
  "extension",
  "plugin",
  "ssh",
  "github",
  "automations",
] as const;

export type PersistedSidebarTab = (typeof SIDEBAR_TABS)[number];
export type SidebarTab = PersistedSidebarTab;

const SIDEBAR_TAB_SET = new Set<string>(SIDEBAR_TABS);

export function normalizeSidebarTab(value: unknown): PersistedSidebarTab {
  return typeof value === "string" && SIDEBAR_TAB_SET.has(value)
    ? (value as PersistedSidebarTab)
    : "spaces";
}
