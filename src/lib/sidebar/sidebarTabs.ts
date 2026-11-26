const SIDEBAR_TABS = [
  "work",
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

/** What a workspace window's main area shows: the Work view of every agent,
 * or the Spaces deck people arrange and type into. */
export type MainView = "work" | "spaces";

/** The ONE rule for the main view: it follows the window's sidebar tab. The
 * Work tab shows Work; every other tab works on Spaces and shows the deck. */
export function mainViewOf(tab: SidebarTab): MainView {
  return tab === "work" ? "work" : "spaces";
}
