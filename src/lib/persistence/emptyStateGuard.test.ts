import { describe, it, expect } from "vitest";
import { isEmptyPersistedState, hasUserData } from "./emptyStateGuard";
import type { PersistedAppState } from "./persistedAppState";
import { DEFAULT_SPACE } from "@/lib/workspace/desktop/desktopNames";
import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import { DEFAULT_NOTIFY_PREFS } from "@/lib/settings/notifyPrefs";

const minimalEmptyState: PersistedAppState = {
	spaces: [DEFAULT_SPACE],
	spaceVisits: {},
	pinnedPanes: {},
	shortcutOverrides: {},
	layouts: {},
	fileTreeSelected: {},
	terminalFontSize: 14,
	terminalPrefs: {},
	uiPrefs: DEFAULT_UI_PREFS,
	notifyPrefs: DEFAULT_NOTIFY_PREFS,
	stats: { agentsStarted: 0, prsCreated: 0, activeMs: 0, since: Date.now() },
	projects: [],
	pinnedProjects: [],
	agents: [],
	sshHosts: [],
	accounts: [],
	activeAccounts: {},
	customThemes: [],
	language: "system",
};

describe("emptyStateGuard", () => {
	describe("isEmptyPersistedState", () => {
		it("identifies empty state with no user data", () => {
			expect(isEmptyPersistedState(minimalEmptyState)).toBe(true);
		});

		it("identifies non-empty state with agents", () => {
			const stateWithAgents: PersistedAppState = {
				...minimalEmptyState,
				agents: [
					{
						id: "test-agent",
						name: "test",
						provider: "local",
						projectId: "test-project",
						sessionId: "test-session",
						sessionKind: "pty",
						worktreePath: "/test",
						branch: "main",
						createdAt: Date.now(),
					},
				],
			};
			expect(isEmptyPersistedState(stateWithAgents)).toBe(false);
		});

		it("identifies non-empty state with accounts", () => {
			const stateWithAccounts: PersistedAppState = {
				...minimalEmptyState,
				accounts: [
					{
						id: "test-account",
						provider: "local",
						name: "Test Account",
						directory: "/test",
					},
				],
			};
			expect(isEmptyPersistedState(stateWithAccounts)).toBe(false);
		});

		it("identifies non-empty state with projects", () => {
			const stateWithProjects: PersistedAppState = {
				...minimalEmptyState,
				projects: [
					{
						id: "test-project",
						name: "Test Project",
						path: "/test",
						kind: "local",
						isRepo: true,
					},
				],
			};
			expect(isEmptyPersistedState(stateWithProjects)).toBe(false);
		});

		it("identifies non-empty state with layouts", () => {
			const stateWithLayouts: PersistedAppState = {
				...minimalEmptyState,
				layouts: {
					"space-1": { panes: [] },
				},
			};
			expect(isEmptyPersistedState(stateWithLayouts)).toBe(false);
		});

		it("identifies non-empty state with multiple data types", () => {
			const stateWithMultiple: PersistedAppState = {
				...minimalEmptyState,
				agents: [
					{
						id: "test-agent",
						name: "test",
						provider: "local",
						projectId: "test-project",
						sessionId: "test-session",
						sessionKind: "pty",
						worktreePath: "/test",
						branch: "main",
						createdAt: Date.now(),
					},
				],
				projects: [
					{
						id: "test-project",
						name: "Test Project",
						path: "/test",
						kind: "local",
						isRepo: true,
					},
				],
			};
			expect(isEmptyPersistedState(stateWithMultiple)).toBe(false);
		});
	});

	describe("hasUserData", () => {
		it("returns false for empty state", () => {
			expect(hasUserData(minimalEmptyState)).toBe(false);
		});

		it("returns true for state with user data", () => {
			const stateWithData: PersistedAppState = {
				...minimalEmptyState,
				agents: [
					{
						id: "test-agent",
						name: "test",
						provider: "local",
						projectId: "test-project",
						sessionId: "test-session",
						sessionKind: "pty",
						worktreePath: "/test",
						branch: "main",
						createdAt: Date.now(),
					},
				],
			};
			expect(hasUserData(stateWithData)).toBe(true);
		});
	});
});
