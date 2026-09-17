// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	invalidatePluginSettingsSnapshot,
	publishPluginSettingsSnapshot,
	resetPluginIssueTrackerWorkspaceResourcesForTests,
	usePluginIssueTrackerWorkspace,
} from "@/components/plugins/usePluginIssueTrackerWorkspace";
import { refreshPluginPermissionWorkspace } from "@/components/plugins/usePluginPermissionWorkspace";
import type {
	DureIssueTrackerActivationEvent,
	DurePluginPermissionSnapshot,
} from "@/lib/ipc/plugins";
import type {
	DurePluginSettingsSnapshot,
	DurePluginSettingsTargetV2,
} from "@/lib/plugins/durePlugins";
import { pluginPermissionReviewFixture } from "@/test/pluginPermissionFixtures";

const mocks = vi.hoisted(() => ({
	activationGet: vi.fn(),
	permissionGet: vi.fn(),
	settingsGet: vi.fn(),
	settingsListen: vi.fn(),
	activationListeners: [] as Array<
		(event: DureIssueTrackerActivationEvent) => void
	>,
	settingsListeners: [] as Array<
		(snapshot: DurePluginSettingsSnapshot) => void
	>,
	permissionListeners: [] as Array<
		(snapshot: DurePluginPermissionSnapshot) => void
	>,
}));

vi.mock("@/lib/ipc", () => ({
	dureIssueTrackerActivationGet: mocks.activationGet,
	durePluginPermissionGet: mocks.permissionGet,
	durePluginSettingsGet: mocks.settingsGet,
	onDureIssueTrackerActivationEvent: vi.fn(
		async (callback: (event: DureIssueTrackerActivationEvent) => void) => {
			mocks.activationListeners.push(callback);
			return vi.fn();
		},
	),
	onDurePluginSettingsEvent: mocks.settingsListen,
	onDurePluginPermissionEvent: vi.fn(
		async (callback: (snapshot: DurePluginPermissionSnapshot) => void) => {
			mocks.permissionListeners.push(callback);
			return vi.fn();
		},
	),
}));

const workspace = {
	root: "/work/project",
	projectId: "project-1",
	scopeKey: "local:local:project-1",
	watchKey: "local:local:project-1",
	source: "local" as const,
};
const settingsTarget: DurePluginSettingsTargetV2 = {
	identity: {
		source_id: "dure.bundled",
		candidate_id: "dure.beads.bundled",
	},
	plugin_id: "dure.beads",
	version: "0.2.0",
	contribution_id: "dure.beads.settings",
};
const workspaceIdentity = `sha256:${"b".repeat(64)}`;
const input = {
	pluginId: "dure.beads",
	contributionId: "dure.beads.issue-tracker",
	settingsTarget,
	workspace,
};

function settings(
	showAgentClaims: boolean,
	settingsRevision = "1",
	identity = workspaceIdentity,
): DurePluginSettingsSnapshot {
	return {
		target: settingsTarget,
		scope: "workspace",
		scope_key: identity,
		settings_revision: settingsRevision,
		values: {
			show_agent_claims: showAgentClaims,
			watch_interval_seconds: 30,
			default_view: "ready",
		},
		agent_claim_policy_epochs: {
			"dure.beads.issue-tracker": showAgentClaims ? 1 : 2,
		},
	};
}

function permission(
	recordRevision: string,
	enabled: boolean,
	identity = workspaceIdentity,
): DurePluginPermissionSnapshot {
	return {
		plan: {
			schema_version: 2,
			identity: {
				plugin_id: input.pluginId,
				publisher: "dure",
				version: "0.2.0",
			},
			authority: {
				authority: "dure.release",
				catalog_snapshot_sha256: `sha256:${"a".repeat(64)}`,
			},
			workspace_identity: identity,
			catalog_selection: {
				source_id: "dure.bundled",
				candidate_id: "dure.beads.bundled",
			},
			applied_policy_digest: `sha256:${"c".repeat(64)}`,
			negotiated_host_api_version: 2,
			activation: [],
			contributions: [],
			ignored_optional_contributions: [],
			agent_integrations: [],
			ignored_optional_agent_integrations: [],
			permissions: [],
			digest: `sha256:${"d".repeat(64)}`,
		},
		review: pluginPermissionReviewFixture(
			`sha256:${"d".repeat(64)}`,
			enabled ? `sha256:${"d".repeat(64)}` : null,
		),
		record_revision: recordRevision,
		decision_revision: enabled ? "1" : "0",
		enablement_epoch: recordRevision,
		decision: enabled ? "approve" : null,
		reviewed_plan_digest: enabled ? `sha256:${"d".repeat(64)}` : null,
		plan_comparison: enabled ? "matches_reviewed_plan" : "no_reviewed_plan",
		enabled,
	};
}

beforeEach(() => {
	mocks.permissionGet.mockResolvedValue(permission("0", false));
	mocks.settingsListen.mockImplementation(
		async (callback: (snapshot: DurePluginSettingsSnapshot) => void) => {
			mocks.settingsListeners.push(callback);
			return vi.fn();
		},
	);
});

afterEach(() => {
	resetPluginIssueTrackerWorkspaceResourcesForTests();
	mocks.activationGet.mockReset();
	mocks.permissionGet.mockReset();
	mocks.settingsGet.mockReset();
	mocks.settingsListen.mockReset();
	mocks.activationListeners.length = 0;
	mocks.settingsListeners.length = 0;
	mocks.permissionListeners.length = 0;
	vi.useRealTimers();
});

describe("usePluginIssueTrackerWorkspace", () => {
	it("shares configuration reads and lets native events outrank stale get responses", async () => {
		let resolveActivation!: (active: boolean) => void;
		let resolvePermission!: (snapshot: DurePluginPermissionSnapshot) => void;
		let resolveSettings!: (snapshot: DurePluginSettingsSnapshot) => void;
		mocks.permissionGet.mockReturnValue(
			new Promise<DurePluginPermissionSnapshot>((resolve) => {
				resolvePermission = resolve;
			}),
		);
		mocks.activationGet.mockReturnValue(
			new Promise<boolean>((resolve) => {
				resolveActivation = resolve;
			}),
		);
		mocks.settingsGet.mockReturnValue(
			new Promise<DurePluginSettingsSnapshot>((resolve) => {
				resolveSettings = resolve;
			}),
		);
		const first = renderHook(() => usePluginIssueTrackerWorkspace(input));
		const second = renderHook(() => usePluginIssueTrackerWorkspace(input));
		await waitFor(() => expect(mocks.permissionListeners).toHaveLength(1));
		await act(async () => resolvePermission(permission("1", false)));
		await waitFor(() => expect(mocks.activationListeners).toHaveLength(1));
		await waitFor(() => expect(mocks.settingsListeners).toHaveLength(1));

		act(() => {
			mocks.activationListeners[0]({
				plugin_id: input.pluginId,
				contribution_id: input.contributionId,
				workspace_root: workspace.root,
				active: true,
			});
			mocks.settingsListeners[0](settings(false, "2"));
			mocks.permissionListeners[0](permission("2", true));
		});
		await act(async () => {
			resolveActivation(false);
			resolveSettings(settings(true, "1"));
		});

		await waitFor(() => expect(first.result.current.activation).toBe("active"));
		expect(first.result.current.settings?.values.show_agent_claims).toBe(false);
		expect(first.result.current.permission?.record_revision).toBe("2");
		expect(first.result.current.permission?.enabled).toBe(true);
		expect(second.result.current).toEqual(first.result.current);
		expect(mocks.permissionGet).toHaveBeenCalledTimes(1);
		expect(mocks.activationGet).toHaveBeenCalledTimes(1);
		expect(mocks.settingsGet).toHaveBeenCalledTimes(1);
	});

	it("rejects settings reads and events for a different package identity", async () => {
		const mismatched = {
			...settings(true),
			target: {
				...settingsTarget,
				identity: {
					...settingsTarget.identity,
					candidate_id: "dure.beads.next",
				},
			},
		};
		mocks.activationGet.mockResolvedValue(true);
		mocks.settingsGet.mockResolvedValue(mismatched);

		const result = renderHook(() => usePluginIssueTrackerWorkspace(input));
		await waitFor(() => expect(result.result.current.settingsLoaded).toBe(true));
		expect(result.result.current.settings).toBeNull();
		expect(result.result.current.settingsError).toBe(
			"plugin_settings_snapshot_target_mismatch",
		);
		expect(mocks.settingsGet).toHaveBeenCalledWith(
			settingsTarget,
			"workspace",
			workspaceIdentity,
			workspace.root,
		);

		act(() => mocks.settingsListeners[0](mismatched));
		expect(result.result.current.settings).toBeNull();
	});

	it("does not read or subscribe to settings for a settings-less package", async () => {
		mocks.activationGet.mockResolvedValue(true);
		const result = renderHook(() =>
			usePluginIssueTrackerWorkspace({ ...input, settingsTarget: null }),
		);

		await waitFor(() =>
			expect(result.result.current.activation).toBe("active"),
		);
		expect(result.result.current.settingsLoaded).toBe(true);
		expect(result.result.current.settings).toBeNull();
		expect(result.result.current.settingsError).toBeNull();
		expect(mocks.settingsGet).not.toHaveBeenCalled();
		expect(mocks.settingsListeners).toHaveLength(0);
	});

	it("loads a defaults-only policy snapshot for an unregistered local workspace", async () => {
		const unregisteredWorkspace = {
			...workspace,
			projectId: null,
			scopeKey: null,
			watchKey: "local:local:unregistered:project",
		};
		mocks.activationGet.mockResolvedValue(true);
		mocks.settingsGet.mockResolvedValue(settings(true));

		const result = renderHook(() =>
			usePluginIssueTrackerWorkspace({
				...input,
				workspace: unregisteredWorkspace,
			}),
		);

		await waitFor(() => expect(result.result.current.settingsLoaded).toBe(true));
		expect(result.result.current.settings?.scope_key).toBe(workspaceIdentity);
		expect(
			result.result.current.settings?.agent_claim_policy_epochs?.[
				"dure.beads.issue-tracker"
			],
		).toBe(1);
		expect(mocks.settingsGet).toHaveBeenCalledWith(
			settingsTarget,
			"workspace",
			workspaceIdentity,
			unregisteredWorkspace.root,
		);
});

	it("fails closed when the settings event stream cannot be observed", async () => {
		vi.useFakeTimers();
		mocks.activationGet.mockResolvedValue(true);
		mocks.settingsGet.mockResolvedValue(settings(true));
		mocks.settingsListen.mockRejectedValue(new Error("event transport down"));

		const result = renderHook(() => usePluginIssueTrackerWorkspace(input));

		await act(async () => {
			await vi.runAllTimersAsync();
		});
		expect(result.result.current.settingsError).toContain(
			"plugin_settings_event_subscription_failed",
		);
		expect(result.result.current.settings?.values.show_agent_claims).toBe(true);
	});

	it("keeps a retryable settings listener failure pending until observation recovers", async () => {
		vi.useFakeTimers();
		mocks.activationGet.mockResolvedValue(true);
		mocks.settingsGet.mockResolvedValue(settings(true));
		mocks.settingsListen.mockRejectedValueOnce(new Error("event transport down"));
		const result = renderHook(() => usePluginIssueTrackerWorkspace(input));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.result.current.settingsError).toBeNull();
		expect(result.result.current.settingsLoaded).toBe(false);
		expect(result.result.current.activation).toBe("checking");
		expect(mocks.settingsListen).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(250);
		});
		expect(mocks.settingsListen).toHaveBeenCalledTimes(2);
		expect(result.result.current.settings?.values.show_agent_claims).toBe(true);
		expect(result.result.current.settingsError).toBeNull();
	});

	it("recovers invalidated settings from a higher revision and rejects stale or conflicting publications", async () => {
		mocks.activationGet.mockResolvedValue(true);
		mocks.settingsGet.mockResolvedValue(settings(true, "1"));
		const result = renderHook(() => usePluginIssueTrackerWorkspace(input));
		await waitFor(() =>
			expect(result.result.current.settings?.settings_revision).toBe("1"),
		);

		act(() =>
			invalidatePluginSettingsSnapshot(result.result.current.settings!),
		);
		expect(result.result.current.settings).toBeNull();
		expect(result.result.current.settingsError).toBe(
			"plugin_settings_revalidation_required",
		);
		act(() => mocks.settingsListeners[0](settings(true, "0")));
		expect(result.result.current.settings).toBeNull();
		act(() => mocks.settingsListeners[0](settings(true, "1")));
		expect(result.result.current.settings).toBeNull();

		act(() => publishPluginSettingsSnapshot(settings(false, "3")));
		expect(result.result.current.settings?.settings_revision).toBe("3");
		expect(result.result.current.settings?.values.show_agent_claims).toBe(false);
		expect(result.result.current.settingsError).toBeNull();

		act(() => publishPluginSettingsSnapshot(settings(true, "2")));
		expect(result.result.current.settings?.settings_revision).toBe("3");
		expect(result.result.current.settings?.values.show_agent_claims).toBe(false);

		act(() => publishPluginSettingsSnapshot(settings(true, "3")));
		expect(result.result.current.settings).toBeNull();
		expect(result.result.current.settingsError).toBe(
			"plugin_settings_snapshot_conflict",
		);
		act(() => publishPluginSettingsSnapshot(settings(false, "2")));
		expect(result.result.current.settings).toBeNull();
		expect(result.result.current.settingsError).toBe(
			"plugin_settings_snapshot_conflict",
		);
	});

	it("uses the newest caller revision as an invalidation fence and requires its settlement token", async () => {
		mocks.activationGet.mockResolvedValue(true);
		mocks.settingsGet.mockResolvedValue(settings(true, "5"));
		const result = renderHook(() => usePluginIssueTrackerWorkspace(input));
		await waitFor(() =>
			expect(result.result.current.settings?.settings_revision).toBe("5"),
		);

		let token: ReturnType<typeof invalidatePluginSettingsSnapshot> = null;
		act(() => {
			token = invalidatePluginSettingsSnapshot(settings(false, "7"));
		});
		expect(token).not.toBeNull();
		act(() => mocks.settingsListeners[0](settings(true, "6")));
		expect(result.result.current.settings).toBeNull();
		let staleReceipt: ReturnType<typeof publishPluginSettingsSnapshot>;
		act(() => {
			staleReceipt = publishPluginSettingsSnapshot(settings(false, "7"));
		});
		expect(staleReceipt!.candidateIsWinner).toBe(false);
		expect(result.result.current.settings).toBeNull();
		let duplicateToken: ReturnType<typeof invalidatePluginSettingsSnapshot> = null;
		act(() => {
			duplicateToken = invalidatePluginSettingsSnapshot(settings(false, "7"));
		});
		expect(duplicateToken).toBeNull();

		let olderToken: ReturnType<typeof invalidatePluginSettingsSnapshot> = null;
		act(() => {
			olderToken = invalidatePluginSettingsSnapshot(settings(true, "6"));
		});
		expect(olderToken).toBeNull();
		let fencedReceipt: ReturnType<typeof publishPluginSettingsSnapshot>;
		act(() => {
			fencedReceipt = publishPluginSettingsSnapshot(
				settings(true, "6"),
				olderToken ?? undefined,
			);
		});
		expect(fencedReceipt!.candidateIsWinner).toBe(false);
		expect(result.result.current.settings).toBeNull();

		let settledReceipt: ReturnType<typeof publishPluginSettingsSnapshot>;
		act(() => {
			settledReceipt = publishPluginSettingsSnapshot(
				settings(false, "7"),
				token ?? undefined,
			);
		});
		expect(settledReceipt!.candidateIsWinner).toBe(true);
		expect(result.result.current.settings?.settings_revision).toBe("7");
		expect(result.result.current.settings?.values.show_agent_claims).toBe(false);
	});

	it("re-anchors settings when an authoritative permission refresh rotates the workspace identity", async () => {
		const rotatedIdentity = `sha256:${"e".repeat(64)}`;
		mocks.activationGet.mockResolvedValue(true);
		mocks.permissionGet.mockResolvedValueOnce(permission("1", true));
		mocks.settingsGet.mockImplementation(
			async (
				_target: DurePluginSettingsTargetV2,
				_scope: "workspace",
				scopeKey?: string,
			) =>
				scopeKey === rotatedIdentity
					? settings(false, "0", rotatedIdentity)
					: settings(true, "9"),
		);
		const result = renderHook(() => usePluginIssueTrackerWorkspace(input));
		await waitFor(() =>
			expect(result.result.current.settings?.scope_key).toBe(workspaceIdentity),
		);

		mocks.permissionGet.mockResolvedValueOnce(
			permission("1", true, rotatedIdentity),
		);
		act(() =>
			refreshPluginPermissionWorkspace({
				pluginId: input.pluginId,
				workspaceRoot: workspace.root,
			}),
		);
		await waitFor(() =>
			expect(result.result.current.permission?.plan.workspace_identity).toBe(
				rotatedIdentity,
			),
		);
		await waitFor(() =>
			expect(result.result.current.settings?.scope_key).toBe(rotatedIdentity),
		);
		expect(result.result.current.settings?.settings_revision).toBe("0");
		expect(mocks.settingsGet).toHaveBeenLastCalledWith(
			settingsTarget,
			"workspace",
			rotatedIdentity,
			workspace.root,
		);

		act(() => mocks.settingsListeners[0](settings(true, "10")));
		expect(result.result.current.settings?.scope_key).toBe(rotatedIdentity);
		expect(result.result.current.settings?.settings_revision).toBe("0");
	});

	it("accepts only monotonic policy epochs at the same durable settings revision", async () => {
		mocks.activationGet.mockResolvedValue(true);
		mocks.settingsGet.mockResolvedValue(settings(true, "4"));
		const result = renderHook(() => usePluginIssueTrackerWorkspace(input));
		await waitFor(() =>
			expect(
				result.result.current.settings?.agent_claim_policy_epochs?.[
					"dure.beads.issue-tracker"
				],
			).toBe(1),
		);

		act(() =>
			publishPluginSettingsSnapshot({
				...settings(true, "4"),
				agent_claim_policy_epochs: { "dure.beads.issue-tracker": 5 },
			}),
		);
		expect(
			result.result.current.settings?.agent_claim_policy_epochs?.[
				"dure.beads.issue-tracker"
			],
		).toBe(5);

		act(() => publishPluginSettingsSnapshot(settings(true, "4")));
		expect(
			result.result.current.settings?.agent_claim_policy_epochs?.[
				"dure.beads.issue-tracker"
			],
		).toBe(5);
		expect(result.result.current.settingsError).toBeNull();
	});
});
