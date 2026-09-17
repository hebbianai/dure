// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	controlPlaneCensus: vi.fn(),
	inspectSessionsExact: vi.fn(),
	setHmuxSessionsMetadata: vi.fn(),
	setSessionAgentRuntimeState: vi.fn(),
	layouts: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getAllWebviewWindows: () =>
		Promise.resolve([
			{
				label: "main",
				isVisible: () => Promise.resolve(true),
				isMinimized: () => Promise.resolve(false),
			},
		]),
}));
vi.mock("@/lib/ipc", () => ({
	hmux: {
		controlPlaneCensus: mocks.controlPlaneCensus,
		inspectSessionsExact: mocks.inspectSessionsExact,
	},
}));
vi.mock("@/lib/workspace/desktop/desktopVisibilityLease", () => ({
	isDesktopWorkspaceWindowLabel: () => false,
	assessDesktopVisibilityLeases: () => ({
		complete: true,
		visibleDesktopIds: new Set(["desk-1"]),
	}),
}));
vi.mock("@/store", () => ({
	useStore: {
		getState: () => ({
			agents: [
				{
					runtimeBinding: {
						runtime: "hmux_managed_v1",
						source: "local",
						sessionId: "s1",
						workspaceId: "w1",
					},
				},
			],
			layouts: mocks.layouts,
			setHmuxSessionsMetadata: mocks.setHmuxSessionsMetadata,
			setSessionAgentRuntimeState: mocks.setSessionAgentRuntimeState,
		}),
	},
}));

import {
	observeManagedControlPlane,
	resetManagedControlPlaneObservationForTest,
} from "./managedControlPlaneObservation";
import { hmuxManagedBinding, hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

describe("observeManagedControlPlane", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00Z"));
		resetManagedControlPlaneObservationForTest();
		mocks.controlPlaneCensus.mockReset();
		mocks.inspectSessionsExact.mockReset();
		mocks.setHmuxSessionsMetadata.mockReset();
		mocks.setSessionAgentRuntimeState.mockReset();
		mocks.layouts = {};
		mocks.controlPlaneCensus.mockRejectedValue(
			new Error("hmux_discovery_result_limit"),
		);
		mocks.inspectSessionsExact.mockResolvedValue([
			{
				outcome: "found",
				session: {
					sessionId: "s1",
					workspaceId: "w1",
					lifecycle: "ready",
					terminalEpoch: "epoch-1",
					outputSeq: "0",
					capabilities: [],
				},
			},
		]);
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(["slot", "launcher:previous", "agent:previous"])("observes actual terminal targets at %s without scanning copied non-terminal bindings", async (panelId) => {
		const binding = hmuxManagedBinding("shell", "dure-local-shells-v1");
		mocks.layouts = { desktop: { panels: {
			[panelId]: { contentComponent: "terminal", params: { sessionId: binding.sessionId, binding } },
			"term:copied": { contentComponent: "launcher", params: { sessionId: "unrelated", binding: hmuxStandaloneBinding("unrelated", "workspace") } },
		} } };
		await observeManagedControlPlane({ maxAgeMs: 0 });
		expect(mocks.inspectSessionsExact).toHaveBeenCalledWith([
			{ sessionId: "s1", workspaceId: "w1" },
			{ sessionId: binding.sessionId, workspaceId: binding.workspaceId },
		]);
	});

	it("projects the Host's current runtime state so a missed stream frame converges", async () => {
		// The inspection already carries the Host's authoritative runtime state.
		// A window that missed one streamed transition (2026-09-14, #840) must
		// converge on it here instead of waiting for the Host's next change.
		const runtime = {
			terminalEpoch: "epoch-1",
			revision: "14",
			observedThroughOutputSeq: "3983",
			lifecycle: "running",
			activity: "working",
			attention: "none",
			source: "provider_event",
			turnCompletedCount: "0",
		} as const;
		mocks.inspectSessionsExact.mockResolvedValue([
			{
				outcome: "found",
				session: {
					sessionId: "s1",
					workspaceId: "w1",
					lifecycle: "ready",
					terminalEpoch: "epoch-1",
					outputSeq: "5181",
					capabilities: [],
				},
				agentRuntimeState: runtime,
			},
		]);
		await observeManagedControlPlane({ maxAgeMs: 0 });
		expect(mocks.setSessionAgentRuntimeState).toHaveBeenCalledWith("s1", runtime);
		expect(mocks.setSessionAgentRuntimeState).toHaveBeenCalledTimes(1);
	});

	it("writes no runtime state for a session the Host has not observed semantically", async () => {
		await observeManagedControlPlane({ maxAgeMs: 0 });
		expect(mocks.setSessionAgentRuntimeState).not.toHaveBeenCalled();
	});

	it("TTL 안의 주기 호출은 한 관측을 공유하고 메타데이터도 1회만 쓴다", async () => {
		const first = await observeManagedControlPlane({ maxAgeMs: 2_500 });
		const second = await observeManagedControlPlane({ maxAgeMs: 2_500 });
		expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(1);
		expect(mocks.controlPlaneCensus).not.toHaveBeenCalled();
		expect(mocks.setHmuxSessionsMetadata).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});

	it("TTL이 지나면 새로 관측한다", async () => {
		await observeManagedControlPlane({ maxAgeMs: 2_500 });
		vi.setSystemTime(new Date("2026-08-05T00:00:03Z"));
		await observeManagedControlPlane({ maxAgeMs: 2_500 });
		expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
	});

	it("경계 호출(maxAgeMs 0)은 캐시가 신선해도 항상 새로 관측한다", async () => {
		await observeManagedControlPlane({ maxAgeMs: 2_500 });
		await observeManagedControlPlane({ maxAgeMs: 0 });
		expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
	});

	it("경계 호출은 진행 중 주기 관측에 합류하지 않는다", async () => {
		const releases: Array<(value: unknown) => void> = [];
		mocks.inspectSessionsExact.mockImplementation(
			() =>
				new Promise((resolve) => {
					releases.push(resolve);
				}),
		);
		const periodic = observeManagedControlPlane({ maxAgeMs: 2_500 });
		const boundary = observeManagedControlPlane({ maxAgeMs: 0 });
		expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
		for (const release of releases) release([]);
		await Promise.all([periodic, boundary]);
	});

	it("동시 주기 호출은 진행 중 관측에 합류한다", async () => {
		let release: (value: unknown) => void = () => {};
		mocks.inspectSessionsExact.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const a = observeManagedControlPlane({ maxAgeMs: 2_500 });
		const b = observeManagedControlPlane({ maxAgeMs: 2_500 });
		release([]);
		await Promise.all([a, b]);
		expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(1);
	});

	it("웹뷰가 숨김이면 관측하지 않는다", async () => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		const result = await observeManagedControlPlane({ maxAgeMs: 2_500 });
		expect(result).toBeUndefined();
		expect(mocks.inspectSessionsExact).not.toHaveBeenCalled();
	});
});
