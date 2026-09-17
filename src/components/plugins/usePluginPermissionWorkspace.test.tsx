// @vitest-environment jsdom

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityRail } from "@/components/sidebar/ActivityRail";
import type { DurePluginViewContainer } from "@/lib/plugins/durePlugins";
import { useStore } from "@/store";
import {
	publishPluginPermissionSnapshot,
	refreshPluginPermissionWorkspace,
	resetPluginPermissionWorkspaceResourcesForTests,
	usePluginPermissionWorkspace,
} from "@/components/plugins/usePluginPermissionWorkspace";
import type { DurePluginPermissionSnapshot } from "@/lib/ipc/plugins";
import { pluginPermissionReviewFixture } from "@/test/pluginPermissionFixtures";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	listen: vi.fn(),
	listeners: [] as Array<(snapshot: DurePluginPermissionSnapshot) => void>,
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...await importOriginal<typeof import("@/lib/ipc")>(),
	durePluginPermissionGet: mocks.get,
	onDurePluginPermissionEvent: mocks.listen,
}));

const input = { pluginId: "dure.beads", workspaceRoot: "/work/repo" };

function permission(
	recordRevision: string,
	decision: DurePluginPermissionSnapshot["decision"] = "approve",
	workspaceIdentity = `sha256:${"b".repeat(64)}`,
): DurePluginPermissionSnapshot {
	const approved = decision === "approve";
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
			workspace_identity: workspaceIdentity,
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
			`sha256:${"d".repeat(64)}`,
		),
		record_revision: recordRevision,
		decision_revision: approved ? "1" : "2",
		enablement_epoch: recordRevision,
		decision,
		reviewed_plan_digest: `sha256:${"d".repeat(64)}`,
		plan_comparison: "matches_reviewed_plan",
		enabled: approved,
	};
}

beforeEach(() => {
	mocks.listen.mockImplementation(
		async (callback: (snapshot: DurePluginPermissionSnapshot) => void) => {
			mocks.listeners.push(callback);
			return vi.fn();
		},
	);
});

afterEach(() => {
	resetPluginPermissionWorkspaceResourcesForTests();
	mocks.get.mockReset();
	mocks.listen.mockReset();
	mocks.listeners.length = 0;
});

describe("usePluginPermissionWorkspace", () => {
	it("updates contributed rail buttons from native permission events without a reload", async () => {
		const initialFocus = useStore.getState().focusCtx;
		useStore.setState({ focusCtx: { cwd: input.workspaceRoot, source: "local", label: "repo" } });
		mocks.get.mockResolvedValue({ ...permission("1"), enabled: false });
		const contribution = {
			plugin: { manifest: { id: input.pluginId } },
			contributionId: "dure.beads.views",
			container: { id: "issues", title: { default: "Beads" }, icon: "list_todo" },
		} as DurePluginViewContainer;
		const view = render(<ActivityRail onOpenSettings={vi.fn()} pluginContainers={[contribution]} />);
		try {
			await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
			expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
			act(() => mocks.listeners[0](permission("2")));
			expect(await screen.findByRole("button", { name: "Beads" })).toBeTruthy();
			act(() => mocks.listeners[0]({ ...permission("3"), enabled: false }));
			expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
			expect(mocks.get).toHaveBeenCalledTimes(1);
		} finally {
			view.unmount();
			useStore.setState({ focusCtx: initialFocus });
		}
	});

	it("keeps a newer native event above delayed get and mutation responses", async () => {
		let resolveGet!: (snapshot: DurePluginPermissionSnapshot) => void;
		mocks.get.mockReturnValue(
			new Promise<DurePluginPermissionSnapshot>((resolve) => {
				resolveGet = resolve;
			}),
		);
		const first = renderHook(() => usePluginPermissionWorkspace(input));
		const second = renderHook(() => usePluginPermissionWorkspace(input));
		await waitFor(() => expect(mocks.listeners).toHaveLength(1));

		act(() => mocks.listeners[0](permission("2")));
		await act(async () => resolveGet(permission("1")));

		await waitFor(() =>
			expect(first.result.current.permission?.record_revision).toBe("2"),
		);
		act(() => {
			mocks.listeners[0](permission("1"));
			publishPluginPermissionSnapshot(permission("1"));
		});
		expect(first.result.current.permission?.record_revision).toBe("2");
		expect(second.result.current).toEqual(first.result.current);
		expect(mocks.get).toHaveBeenCalledTimes(1);
	});

	it("fails every shared consumer closed on an equal-revision conflict", async () => {
		mocks.get.mockResolvedValueOnce(permission("2"));
		const first = renderHook(() => usePluginPermissionWorkspace(input));
		const second = renderHook(() => usePluginPermissionWorkspace(input));
		await waitFor(() =>
			expect(first.result.current.permission?.record_revision).toBe("2"),
		);
		mocks.get.mockReturnValue(new Promise(() => {}));

		act(() => mocks.listeners[0](permission("2", "reject")));

		await waitFor(() => expect(first.result.current.permission).toBeNull());
		expect(first.result.current.permissionError).toBe(
			"plugin_permission_snapshot_conflict",
		);
		expect(second.result.current).toEqual(first.result.current);
		expect(mocks.listeners).toHaveLength(1);
	});

	it("retries native event registration on an explicit refresh", async () => {
		mocks.listen.mockRejectedValueOnce(new Error("listener unavailable"));
		mocks.get.mockResolvedValue(permission("1"));
		const view = renderHook(() => usePluginPermissionWorkspace(input));
		await waitFor(() => expect(view.result.current.permissionLoaded).toBe(true));
		expect(mocks.listen).toHaveBeenCalledTimes(1);
		expect(mocks.get).not.toHaveBeenCalled();
		expect(view.result.current.permission).toBeNull();
		expect(view.result.current.permissionError).toContain(
			"plugin_permission_event_subscription_failed",
		);

		act(() => publishPluginPermissionSnapshot(permission("1")));
		expect(view.result.current.permission).toBeNull();

		act(() => refreshPluginPermissionWorkspace(input));

		await waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2));
		expect(mocks.listeners).toHaveLength(1);
		await waitFor(() =>
			expect(view.result.current.permission?.record_revision).toBe("1"),
		);
	});

	it("adopts a rotated workspace identity only from an authoritative refresh", async () => {
		const oldIdentity = `sha256:${"b".repeat(64)}`;
		const newIdentity = `sha256:${"e".repeat(64)}`;
		mocks.get.mockResolvedValueOnce(permission("1", "approve", oldIdentity));
		const view = renderHook(() => usePluginPermissionWorkspace(input));
		await waitFor(() =>
			expect(view.result.current.permission?.plan.workspace_identity).toBe(
				oldIdentity,
			),
		);

		act(() => mocks.listeners[0](permission("2", "approve", newIdentity)));
		expect(view.result.current.permission?.plan.workspace_identity).toBe(
			oldIdentity,
		);

		mocks.get.mockResolvedValueOnce(permission("1", "approve", newIdentity));
		act(() => refreshPluginPermissionWorkspace(input));
		await waitFor(() =>
			expect(view.result.current.permission?.plan.workspace_identity).toBe(
				newIdentity,
			),
		);
		act(() => mocks.listeners[0](permission("3", "approve", oldIdentity)));
		expect(view.result.current.permission?.plan.workspace_identity).toBe(
			newIdentity,
		);
});

	it("reloads every active resource after shared listener recovery without publishing to an unmounted peer", async () => {
		const secondInput = { ...input, workspaceRoot: "/work/other" };
		const getResolvers = new Map<
			string,
			(snapshot: DurePluginPermissionSnapshot) => void
		>();
		mocks.listen.mockRejectedValueOnce(new Error("listener unavailable"));
		mocks.get.mockImplementation(
			(request: { workspace_root: string }) =>
				new Promise<DurePluginPermissionSnapshot>((resolve) => {
					getResolvers.set(request.workspace_root, resolve);
				}),
		);

		const first = renderHook(() => usePluginPermissionWorkspace(input));
		const secondPermissions: Array<DurePluginPermissionSnapshot | null> = [];
		const second = renderHook(() => {
			const snapshot = usePluginPermissionWorkspace(secondInput);
			secondPermissions.push(snapshot.permission);
			return snapshot;
		});
		await waitFor(() =>
			expect(first.result.current.permissionError).toContain(
				"plugin_permission_event_subscription_failed",
			),
		);
		await waitFor(() =>
			expect(second.result.current.permissionError).toContain(
				"plugin_permission_event_subscription_failed",
			),
		);
		expect(mocks.listen).toHaveBeenCalledTimes(1);
		expect(mocks.get).not.toHaveBeenCalled();

		act(() => refreshPluginPermissionWorkspace(input));

		await waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(getResolvers.size).toBe(2));
		expect(
			mocks.get.mock.calls
				.map(([request]) => request.workspace_root)
				.sort(),
		).toEqual([input.workspaceRoot, secondInput.workspaceRoot].sort());

		second.unmount();
		await act(async () => Promise.resolve());
		const secondRenderCount = secondPermissions.length;
		const secondPermission = permission("1");
		secondPermission.plan.workspace_identity = `sha256:${"e".repeat(64)}`;
		await act(async () => {
			getResolvers.get(input.workspaceRoot)?.(permission("1"));
			getResolvers.get(secondInput.workspaceRoot)?.(secondPermission);
		});

		await waitFor(() =>
			expect(first.result.current.permission?.record_revision).toBe("1"),
		);
		expect(secondPermissions).toHaveLength(secondRenderCount);
	});
});
