import { describe, it, expect, vi } from "vitest";
import { isEmptyPersistedState, hasUserData } from "./emptyStateGuard";
import type { PersistedAppState } from "./persistedAppState";
import { DEFAULT_SPACE } from "@/lib/workspace/desktop/desktopNames";
import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import { DEFAULT_NOTIFY_PREFS } from "@/lib/settings/notifyPrefs";
import { DEFAULT_TERMINAL_PREFS } from "@/lib/terminal/terminalPrefs";

// Mock the Tauri window API for testing secondary window detection
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: vi.fn(),
}));

const minimalEmptyState: PersistedAppState = {
	spaces: [DEFAULT_SPACE],
	spaceVisits: {},
	pinnedPanes: {},
	shortcutOverrides: {},
	layouts: {},
	fileTreeSelected: {},
	terminalFontSize: 14,
	terminalPrefs: DEFAULT_TERMINAL_PREFS,
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
				provider: "claude",
				projectId: "test-project",
				sessionId: "test-session",
					sessionKind: "pty",
					worktreePath: "/test",
					branch: "main",
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
					provider: "claude",
					name: "Test Account",
					dir: "/test",
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
				provider: "claude",
				projectId: "test-project",
				sessionId: "test-session",
					sessionKind: "pty",
					worktreePath: "/test",
					branch: "main",
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
				provider: "claude",
				projectId: "test-project",
				sessionId: "test-session",
					sessionKind: "pty",
					worktreePath: "/test",
					branch: "main",
				},
			],
			};
			expect(hasUserData(stateWithData)).toBe(true);
		});
	});

	describe("multi-window data loss scenario (2026-10-19 forensic)", () => {
		it("simulates secondary window hydration failure writing empty state", () => {
			// Simulates the forensic scenario:
			// - Secondary window (window-fea75937) fails hydration at 16:07:34
			// - Writes empty default state to shared agent-ide localStorage
			// - Main window rehydrates from the now-empty shared storage
			// - agents.json updated with empty state at 16:18:26
			
			const populatedState: PersistedAppState = {
				...minimalEmptyState,
			agents: [
				{
					id: "agent-before-loss",
					name: "production-agent",
					provider: "claude",
					projectId: "prod-project",
					sessionId: "prod-session",
					sessionKind: "pty",
					worktreePath: "/prod",
					branch: "main",
				},
			],
			accounts: [
				{
					id: "account-1",
					provider: "claude",
					name: "Production Account",
					dir: "/accounts/prod",
				},
			],
				projects: [
					{
						id: "prod-project",
						name: "Production",
						path: "/prod",
						kind: "local",
						isRepo: true,
					},
				],
				layouts: {
					"space-1": { panes: [] },
				},
			};

			const emptyStateFromFailedSecondaryWindow: PersistedAppState = {
				...minimalEmptyState,
			};

			// Before the incident: populated state
			expect(hasUserData(populatedState)).toBe(true);
			expect(isEmptyPersistedState(populatedState)).toBe(false);

			// After secondary window hydration failure: empty state
			expect(hasUserData(emptyStateFromFailedSecondaryWindow)).toBe(false);
			expect(isEmptyPersistedState(emptyStateFromFailedSecondaryWindow)).toBe(true);

			// The guard should detect this as empty-over-non-empty
			// and prevent the write from the secondary window
		});
	});
});
