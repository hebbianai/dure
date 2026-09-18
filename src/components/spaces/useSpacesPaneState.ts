// SpacesPane store wiring: subscriptions project the existing authorities;
// stable accessors read current state when a handler runs.
import { useCallback, useMemo } from "react";
import { adoptAgent } from "@/lib/agents/agentRegistration";
import type { SpacesViewOptions } from "@/lib/spaces/spacesViewOptions";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { selectUnopenedAgents } from "@/lib/workspace/layout/agentPaneLocations";
import {
  createSpacesAttentionSelector,
  createSpacesRuntimeSelector,
} from "@/lib/spaces/spacesRuntimeProjection";
import type { HiddenPaneRecord } from "@/lib/workspace/pane/hiddenPanesStore";
import { type AppState, DEFAULT_UI_PREFS, useStore } from "@/store";
import type { Agent, Provider } from "@/types";

/** Handler-time read of the active desktop id — an access, not a subscription. */
export const readActiveDesktopId = () => useStore.getState().activeDesktopId;

/** Whether one desktop is the active one. A boolean subscription per heading,
 *  so a space switch re-renders the two headings it changes and nothing else. */
export function useIsActiveDesktop(desktopId: string): boolean {
  return useStore((state) => state.activeDesktopId === desktopId);
}

/** A repository heading's pin: whether its project is pinned, and the toggle.
 *  A boolean subscription per heading, so pinning re-renders that heading
 *  and the pinned band, not every heading. */
export function useProjectPin(projectId: string | undefined) {
  const pinned = useStore((state) =>
    projectId ? state.pinnedProjects.includes(projectId) : false,
  );
  const togglePin = useStore((state) => state.toggleProjectPin);
  return { pinned, togglePin };
}

/** The focused pane's row when it is one of `rows` (and in the active space),
 *  else null. A per-group subscription: a focus change re-renders only the
 *  group that gains or loses the focused row — a folded group keeps showing
 *  that one row. */
export function useFocusedRowIn<Row extends { key: string; desktopId: string }>(
  rows: readonly Row[],
): Row | null {
  return useStore((state) => {
    const key = state.focusCtx?.key;
    if (!key) return null;
    const row = rows.find((candidate) => candidate.key === key);
    return row && row.desktopId === state.activeSpaceId ? row : null;
  });
}

/** Handler-time read of the agent registry — keeps row handlers identity-stable
 *  so the memoized repository groups never re-render for a handler rebind. */
export const readAgents = () => useStore.getState().agents;

// ── Repository quick-add reads (consumed by useRepositoryQuickAdd) ──────────
// All handler-time: the quick-add callbacks must keep one identity for the
// whole pane's life, or every memoized repository group re-renders whenever an
// account, host, or project record changes.

/** The registered project for a folder, registering it on demand — the same
 *  action the add-agent dialog uses for a hand-picked location. */
export const ensureProjectForPath: AppState["ensureProjectForPath"] = (
  path,
  hostId,
) => useStore.getState().ensureProjectForPath(path, hostId);

export const readSshHosts = () => useStore.getState().sshHosts;
export const readAgentPanePreferences = () => useStore.getState().uiPrefs;

/** Credential profiles and the provider's active one — quick-add launches
 *  under the same account the dialog would have preselected. */
export const readAccounts = () => useStore.getState().accounts;

export const readActiveAccountId = (provider: Provider) =>
  useStore.getState().activeAccounts[provider];

/** The space that will host a quick-added pane, resolved at launch time. */
export const readSpaceById = (spaceId: string) =>
  useStore.getState().spaces.find((space) => space.id === spaceId);

export function useSpacesPaneState() {
  const agents = useStore((state) => state.agents);
  const desktops = useStore((state) => state.desktops);
  const projects = useStore((state) => state.projects);
  const pinnedPanes = useStore((state) => state.pinnedPanes);
  const detected = useStore((state) => state.detected);
  const activeDesktopId = useStore((state) => state.activeDesktopId);
  // The focused pane's row key — a folded repository still shows that row,
  // so the selection order (useSpacesGroups) must know it.
  const focusedRowKey = useStore((state) => state.focusCtx?.key ?? null);
  const setActiveDesktop = useStore((state) => state.setActiveDesktop);
  // 저장소 머리행 SSH 배지의 툴팁 — 원격 host id를 사람이 읽는 이름으로.
  const sshHosts = useStore((state) => state.sshHosts);
  // One projection contract owns every Spaces view choice. Later grouping,
  // ordering, field, and filter facets extend this object rather than adding
  // parallel top-level preferences.
  const spacesViewOptions = useStore(
    (state) =>
      state.uiPrefs?.spacesViewOptions ?? DEFAULT_UI_PREFS.spacesViewOptions,
  );
  const setUiPrefs = useStore((state) => state.setUiPrefs);
  const setSpacesViewOptions = useCallback(
    (value: SpacesViewOptions) => setUiPrefs({ spacesViewOptions: value }),
    [setUiPrefs],
  );
  return {
    spacesViewOptions,
    setSpacesViewOptions,
    agents,
    desktops,
    projects,
    pinnedPanes,
    detected,
    activeDesktopId,
    focusedRowKey,
    setActiveDesktop,
    sshHosts,
    readActiveDesktopId,
    readAgents,
    adoptAgent,
  };
}

/** Keep hidden unopened candidates in scope so a new episode can reveal them.
 * Hidden panes already have rows in useSpaces and are excluded here. */
export function useUnopenedAgentsState(
  agents: readonly Agent[],
  openAgentIds: ReadonlySet<string>,
  hiddenPaneIds: Readonly<Record<string, HiddenPaneRecord>>,
) {
  const { candidates, selectRuntime, selectAttention } = useMemo(() => {
    const candidates = selectUnopenedAgents(agents, openAgentIds).filter(
      (agent) => !(agent.id in hiddenPaneIds),
    );
    const ids = candidates.map((agent) => agent.id);
    return {
      candidates,
      selectRuntime: createSpacesRuntimeSelector([], ids),
      selectAttention: createSpacesAttentionSelector(ids),
    };
  }, [agents, openAgentIds, hiddenPaneIds]);
  const { agentActivity: activity } = useStore(selectRuntime);
  const attention = useAgentAttention(selectAttention);
  return { candidates, activity, ...attention };
}
