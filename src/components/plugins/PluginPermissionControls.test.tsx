// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DurePluginPermissionDisableReceipt,
	DurePluginPermissionSnapshot,
} from "@/lib/ipc/plugins";
import { pluginPermissionReviewFixture } from "@/test/pluginPermissionFixtures";

const mocks = vi.hoisted(() => ({
	decide: vi.fn(),
	enable: vi.fn(),
	disable: vi.fn(),
	publish: vi.fn(),
	refresh: vi.fn(),
	permissionByRoot: new Map<string, DurePluginPermissionSnapshot>(),
}));

vi.mock("@/components/plugins/usePluginPermissionWorkspace", () => ({
	usePluginPermissionWorkspace: ({ workspaceRoot }: { workspaceRoot: string }) => ({
		permission: mocks.permissionByRoot.get(workspaceRoot) ?? null,
		permissionLoaded: true,
		permissionError: null,
	}),
	publishPluginPermissionSnapshot: mocks.publish,
	refreshPluginPermissionWorkspace: mocks.refresh,
}));

vi.mock("@/lib/ipc/plugins", () => ({
	durePluginPermissionDecide: mocks.decide,
	durePluginPermissionEnable: mocks.enable,
	durePluginPermissionDisable: mocks.disable,
}));

import { PluginPermissionControls } from "@/components/plugins/PluginPermissionControls";

function permission(
	workspaceIdentity: string,
	decision: DurePluginPermissionSnapshot["decision"] = null,
	enabled = false,
): DurePluginPermissionSnapshot {
	return {
		plan: {
			schema_version: 2,
			identity: {
				plugin_id: "dure.beads",
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
			permissions: [
				{
					kind: "dure.issue-tracker.read",
					parameters: { operations: ["activate", "list", "watch"] },
				},
			],
			digest: `sha256:${"d".repeat(64)}`,
		},
		review: pluginPermissionReviewFixture(
			`sha256:${"d".repeat(64)}`,
			decision ? `sha256:${"d".repeat(64)}` : null,
		),
		record_revision: decision ? "1" : "0",
		decision_revision: decision ? "1" : "0",
		enablement_epoch: enabled ? "2" : decision ? "1" : "0",
		decision,
		reviewed_plan_digest: decision ? `sha256:${"d".repeat(64)}` : null,
		plan_comparison: decision ? "matches_reviewed_plan" : "no_reviewed_plan",
		enabled,
	};
}

function disableReceipt(
	snapshot: DurePluginPermissionSnapshot,
	runtimeRetirement: DurePluginPermissionDisableReceipt["runtime_retirement"],
	disableRequestPersistence: DurePluginPermissionDisableReceipt["disable_request_persistence"] =
		"recorded",
): DurePluginPermissionDisableReceipt {
	return {
		...snapshot,
		disable_request_persistence: disableRequestPersistence,
		runtime_retirement: runtimeRetirement,
	};
}

beforeEach(() => {
	vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
	mocks.permissionByRoot.set("/work/a", permission(`sha256:${"a".repeat(64)}`));
});

afterEach(() => {
	cleanup();
	mocks.permissionByRoot.clear();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("PluginPermissionControls", () => {
	it("binds approval to the exact displayed plan digest", async () => {
		const approved = permission(`sha256:${"a".repeat(64)}`, "approve");
		mocks.decide.mockResolvedValue(approved);
		render(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "권한 승인" }));
		expect(
			screen
				.getByRole("button", { name: "권한 승인" })
				.parentElement?.getAttribute("aria-busy"),
		).toBe("true");
		const savingStatus = screen.getByText("저장 중…").closest('[role="status"]');
		expect(savingStatus).toBeTruthy();
		expect(savingStatus?.closest('[aria-busy="true"]')).toBeNull();

		await waitFor(() => expect(mocks.decide).toHaveBeenCalledTimes(1));
		expect(mocks.decide).toHaveBeenCalledWith({
			plugin_id: "dure.beads",
			workspace_root: "/work/a",
			request_id: "ui:11111111-1111-4111-8111-111111111111",
			expected_record_revision: "0",
			expected_plan_digest: `sha256:${"d".repeat(64)}`,
			decision: "approve",
		});
		expect(mocks.publish).toHaveBeenCalledWith(approved);
	});

	it("uses an unconditional disable intent without a stale CAS field", async () => {
		const enabled = permission(
			`sha256:${"a".repeat(64)}`,
			"approve",
			true,
		);
		mocks.permissionByRoot.set("/work/a", enabled);
		const disabled = { ...enabled, enabled: false };
		mocks.disable.mockResolvedValue(
			disableReceipt(disabled, "succeeded"),
		);
		render(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "플러그인 끄기" }));

		await waitFor(() => expect(mocks.disable).toHaveBeenCalledTimes(1));
		expect(mocks.disable).toHaveBeenCalledWith({
			plugin_id: "dure.beads",
			workspace_root: "/work/a",
			request_id: "ui:11111111-1111-4111-8111-111111111111",
		});
		expect(mocks.publish).toHaveBeenCalledWith(disabled);
	});

	it("requires a fresh disable retry after runtime retirement fails", async () => {
		const enabled = permission(
			`sha256:${"a".repeat(64)}`,
			"approve",
			true,
		);
		const disabled = { ...enabled, enabled: false, enablement_epoch: "3" };
		mocks.permissionByRoot.set("/work/a", enabled);
		mocks.disable
			.mockResolvedValueOnce(disableReceipt(disabled, "failed"))
			.mockResolvedValueOnce(
				disableReceipt(
					disabled,
					"succeeded",
					"retirement_repair_no_transition",
				),
			);
		const randomUUID = vi
			.fn()
			.mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
			.mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
		vi.stubGlobal("crypto", { randomUUID });
		render(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "플러그인 끄기" }));

		const retry = await screen.findByRole("button", {
			name: "런타임 정리 다시 시도",
		});
		expect(
			screen.getByText(
				"권한은 꺼졌지만 실행 중인 플러그인 런타임을 정리하지 못했습니다. 정리가 끝날 때까지 다시 켤 수 없습니다.",
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "플러그인 켜기" })).toBeNull();
		expect(screen.queryByRole("button", { name: "플러그인 끄기" })).toBeNull();

		fireEvent.click(retry);

		await waitFor(() => expect(mocks.disable).toHaveBeenCalledTimes(2));
		expect(mocks.disable).toHaveBeenNthCalledWith(1, {
			plugin_id: "dure.beads",
			workspace_root: "/work/a",
			request_id: "ui:11111111-1111-4111-8111-111111111111",
		});
		expect(mocks.disable).toHaveBeenNthCalledWith(2, {
			plugin_id: "dure.beads",
			workspace_root: "/work/a",
			request_id: "ui:22222222-2222-4222-8222-222222222222",
		});
		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "런타임 정리 다시 시도" }),
			).toBeNull();
		});
	});

	it("clears runtime retirement repair state when the target changes", async () => {
		const enabledA = permission(
			`sha256:${"a".repeat(64)}`,
			"approve",
			true,
		);
		const enabledB = permission(
			`sha256:${"b".repeat(64)}`,
			"approve",
			true,
		);
		mocks.permissionByRoot.set("/work/a", enabledA);
		mocks.permissionByRoot.set("/work/b", enabledB);
		mocks.disable.mockResolvedValue(
			disableReceipt({ ...enabledA, enabled: false }, "failed"),
		);
		const view = render(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "플러그인 끄기" }));
		await screen.findByRole("button", { name: "런타임 정리 다시 시도" });

		view.rerender(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/b"
			/>,
		);

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "런타임 정리 다시 시도" }),
			).toBeNull();
		});
		expect(screen.getByRole("button", { name: "플러그인 끄기" })).toBeTruthy();
	});

	it("keeps an ambiguous disable failure on the repair path", async () => {
		const enabled = permission(
			`sha256:${"a".repeat(64)}`,
			"approve",
			true,
		);
		mocks.permissionByRoot.set("/work/a", enabled);
		mocks.disable.mockRejectedValue(new Error("ambiguous disable failure"));
		render(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "플러그인 끄기" }));

		expect(
			await screen.findByRole("button", { name: "런타임 정리 다시 시도" }),
		).toBeTruthy();
		expect(mocks.refresh).toHaveBeenCalledWith({
			pluginId: "dure.beads",
			workspaceRoot: "/work/a",
		});
		expect(screen.queryByRole("button", { name: "플러그인 켜기" })).toBeNull();
	});

	it("describes non-permission plan drift as an approval-scope change", () => {
		const changed = permission(`sha256:${"a".repeat(64)}`, "approve");
		changed.plan_comparison = "changed_since_review";
		changed.reviewed_plan_digest = `sha256:${"e".repeat(64)}`;
		changed.review = {
			...changed.review,
			comparison: {
				status: "changed_since_review",
				reviewed_plan_digest: `sha256:${"e".repeat(64)}`,
				diff: {
					changes: [],
					catalog_snapshot_fingerprint_only: true,
				},
			},
		};
		mocks.permissionByRoot.set("/work/a", changed);

		render(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);

		expect(screen.getByText("승인 범위 변경됨 · 다시 검토 필요")).toBeTruthy();
		expect(screen.getByText("Workspace 이슈 읽기")).toBeTruthy();
	});

	it("drops a late A response across an A-B-A target generation", async () => {
		let resolveA!: (snapshot: DurePluginPermissionSnapshot) => void;
		mocks.decide.mockReturnValue(
			new Promise<DurePluginPermissionSnapshot>((resolve) => {
				resolveA = resolve;
			}),
		);
		mocks.permissionByRoot.set("/work/b", permission(`sha256:${"b".repeat(64)}`));
		const view = render(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "권한 승인" }));

		view.rerender(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/b"
			/>,
		);
		view.rerender(
			<PluginPermissionControls
				pluginName="Beads"
				pluginId="dure.beads"
				workspaceRoot="/work/a"
			/>,
		);
		await waitFor(() => {
			const approve = screen.getByRole("button", { name: "권한 승인" });
			expect((approve as HTMLButtonElement).disabled).toBe(false);
		});
		resolveA(permission(`sha256:${"a".repeat(64)}`, "approve"));
		await Promise.resolve();

		expect(mocks.publish).not.toHaveBeenCalled();
	});
});
