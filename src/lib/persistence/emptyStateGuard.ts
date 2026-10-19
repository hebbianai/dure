import type { PersistedAppState } from "@/lib/persistence/persistedAppState";

/**
 * Checks whether a persisted state value is "empty" in the sense that it lost
 * all meaningful user data — agents, accounts, projects, and layout panes.
 *
 * This guard prevents catastrophic data loss from hydration failures where
 * an empty/default state overwrites a populated localStorage.
 */
export function isEmptyPersistedState(state: PersistedAppState): boolean {
	const hasAgents = Array.isArray(state.agents) && state.agents.length > 0;
	const hasAccounts = Array.isArray(state.accounts) && state.accounts.length > 0;
	const hasProjects = Array.isArray(state.projects) && state.projects.length > 0;
	const hasLayouts = Object.keys(state.layouts).length > 0;

	return !hasAgents && !hasAccounts && !hasProjects && !hasLayouts;
}

/**
 * Checks whether a state has any of the key collections that would make
 * it non-empty (agents, accounts, projects, or layouts).
 */
export function hasUserData(state: PersistedAppState): boolean {
	return !isEmptyPersistedState(state);
}
