// @vitest-environment jsdom
// 설정이 꺼져 있으면 아무것도 그리지 않고 표본도 뜨지 않는다 — 보지 않는
// 숫자를 위해 4초마다 IPC가 도는 것은 조용한 비용이라 이 계약을 잠근다.
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const systemResourcesMock = vi.fn();
const inspectIdleMock = vi.fn();
vi.mock("@/lib/ipc/dureAgentIdle", () => ({
	inspectLocalAgentIdle: () => inspectIdleMock(),
}));
vi.mock("@/lib/ipc", () => ({
	systemResources: (path?: string) => systemResourcesMock(path),
}));

import { ResourceMonitor } from "@/components/usage/ResourceMonitor";
import { t } from "@/lib/i18n";
import { DEFAULT_UI_PREFS, useStore } from "@/store";
import type { AgentRuntimeIdleInspection } from "@/lib/ipc/dureAgentIdle";
import { managedAgentFixture } from "@/test/agentFixtures";

const snapshot: AgentRuntimeIdleInspection = {
	schemaVersion: 1,
	configuration: "enabled",
	afterMs: 86_400_000,
	policyRevision: 2,
	observedAtMs: 1000,
	partial: true,
	reasonCode: null,
	agents: [
		{
			agentId: "agent-first",
			state: "protected",
			observedIdleMs: null,
			reasonCode: "hmux_controller_input_pending",
		},
	],
};
async function openDiagnostics() {
	fireEvent.click(
		await screen.findByRole("button", { name: t("usage.cleanup.title") }),
	);
}

beforeEach(() => {
	inspectIdleMock.mockResolvedValue(snapshot);
	systemResourcesMock.mockResolvedValue({
		cpuPercent: 12.4,
		memoryUsedBytes: 4.5 * 1024 ** 3,
		memoryTotalBytes: 16 * 1024 ** 3,
		diskFreeBytes: 120 * 1024 ** 3,
		diskTotalBytes: 926 * 1024 ** 3,
	});
	// The widget is pro-only; the fresh-store default is basic.
	useStore.setState({
		uiPrefs: { ...DEFAULT_UI_PREFS, interfaceMode: "pro" },
		agents: [],
		projects: [],
	});
});

afterEach(() => {
	cleanup();
	systemResourcesMock.mockReset();
	inspectIdleMock.mockReset();
	vi.useRealTimers();
	useStore.setState({ uiPrefs: { ...DEFAULT_UI_PREFS } });
});

describe("ResourceMonitor", () => {
	it("opens read-only cleanup diagnostics from the Pro resource widget", async () => {
		render(<ResourceMonitor />);
		await screen.findByText("CPU 12%");
		fireEvent.click(
			screen.getByRole("button", { name: t("usage.cleanup.title") }),
		);
		expect(
			await screen.findByRole("dialog", { name: t("usage.cleanup.title") }),
		).toBeTruthy();
	});
	it("reads only when opened or manually refreshed and replaces the scan page", async () => {
		render(<ResourceMonitor />);
		await screen.findByText("CPU 12%");
		expect(inspectIdleMock).not.toHaveBeenCalled();
		await openDiagnostics();
		await screen.findByText("agent-first");
		expect(screen.getByText(t("usage.cleanup.inputPending"))).toBeTruthy();
		expect(screen.getByText(t("usage.cleanup.partial"))).toBeTruthy();
		vi.useFakeTimers();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});
		expect(inspectIdleMock).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
		inspectIdleMock.mockResolvedValue({
			...snapshot,
			partial: false,
			agents: [
				{
					agentId: "agent-next",
					state: "future_state",
					observedIdleMs: null,
					reasonCode: "future_reason",
				},
			],
		});
		fireEvent.click(screen.getByRole("button", { name: t("common.refresh") }));
		await screen.findByText("agent-next");
		expect(screen.queryByText("agent-first")).toBeNull();
		expect(screen.getByText(t("usage.cleanup.lastPage"))).toBeTruthy();
		expect(screen.getByText("future_state")).toBeTruthy();
		expect(screen.getByText("future_reason")).toBeTruthy();
	});
	it("ignores a closed read and performs a new read when reopened", async () => {
		let finish!: (value: AgentRuntimeIdleInspection) => void;
		inspectIdleMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		render(<ResourceMonitor />);
		await openDiagnostics();
		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
		await openDiagnostics();
		await screen.findByText("agent-first");
		await act(async () =>
			finish({
				...snapshot,
				agents: [{ ...snapshot.agents[0], agentId: "agent-stale" }],
			}),
		);
		expect(screen.queryByText("agent-stale")).toBeNull();
		expect(inspectIdleMock).toHaveBeenCalledTimes(2);
	});
	it("closes on Basic mode and does not reopen after returning to Pro", async () => {
		render(<ResourceMonitor />);
		await openDiagnostics();
		await screen.findByText("agent-first");
		act(() =>
			useStore.setState((state) => ({
				uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" },
			})),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		act(() =>
			useStore.setState((state) => ({
				uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
			})),
		);
		await screen.findByText("CPU 12%");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(inspectIdleMock).toHaveBeenCalledTimes(1);
	});
	it("keeps failed reads retryable without presenting an empty census", async () => {
		inspectIdleMock.mockRejectedValueOnce(new Error("offline"));
		render(<ResourceMonitor />);
		await openDiagnostics();
		await screen.findByRole("alert");
		expect(screen.queryByText(t("usage.cleanup.empty"))).toBeNull();
		inspectIdleMock.mockResolvedValue({
			...snapshot,
			configuration: "disabled",
			afterMs: null,
			observedAtMs: null,
			agents: [],
		});
		fireEvent.click(screen.getByRole("button", { name: t("common.refresh") }));
		await screen.findByText(t("usage.cleanup.disabled"));
		expect(screen.getByText(t("usage.cleanup.unobserved"))).toBeTruthy();
		expect(screen.getByText(t("usage.cleanup.empty"))).toBeTruthy();
	});
	it("uses only matching local labels, with unknown identities left as IDs", async () => {
		const local = managedAgentFixture({
			id: "agent-first",
			displayName: "Local label",
		});
		const remote = managedAgentFixture({
			id: "agent-remote",
			displayName: "Wrong remote label",
		});
		if (remote.runtimeBinding?.runtime !== "hmux_managed_v1")
			throw new Error("fixture binding missing");
		remote.runtimeBinding = {
			...remote.runtimeBinding,
			backendProfileId: "remote",
		};
		useStore.setState({ agents: [local, remote] });
		inspectIdleMock.mockResolvedValue({
			...snapshot,
			agents: [
				snapshot.agents[0],
				{ ...snapshot.agents[0], agentId: "agent-remote" },
			],
		});
		render(<ResourceMonitor />);
		await openDiagnostics();
		await screen.findByText("Local label");
		expect(screen.queryByText("Wrong remote label")).toBeNull();
		expect(screen.getByText("agent-remote")).toBeTruthy();
	});
	it("shows invalid policy and its diagnostic without claiming cleanup is enabled", async () => {
		inspectIdleMock.mockResolvedValue({
			...snapshot,
			configuration: "invalid",
			afterMs: null,
			observedAtMs: null,
			reasonCode: "runtime_idle_policy_unavailable",
			agents: [],
		});
		render(<ResourceMonitor />);
		await openDiagnostics();
		await screen.findByText(t("usage.cleanup.invalid"));
		expect(screen.getByText("runtime_idle_policy_unavailable")).toBeTruthy();
	});
	it("꺼져 있으면 표본을 뜨지 않는다", () => {
		useStore.getState().setUiPrefs({ showResourceMonitor: false });
		render(<ResourceMonitor />);

		expect(systemResourcesMock).not.toHaveBeenCalled();
		expect(inspectIdleMock).not.toHaveBeenCalled();
		expect(screen.queryByText(/CPU/)).toBeNull();
	});

	it("pro에서는 기본값만으로 보인다 — 설정을 켤 필요가 없다", async () => {
		render(<ResourceMonitor />);

		await waitFor(() => expect(screen.getByText("CPU 12%")).toBeTruthy());
	});

	it("basic 모드에서는 설정과 무관하게 접히고 폴링도 없다", () => {
		useStore.getState().setUiPrefs({ showResourceMonitor: true });
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" as const },
		}));
		render(<ResourceMonitor />);

		expect(systemResourcesMock).not.toHaveBeenCalled();
		expect(inspectIdleMock).not.toHaveBeenCalled();
		expect(screen.queryByText(/CPU/)).toBeNull();
	});

	it("켜면 CPU·메모리·세션·디스크를 한 줄로 그린다", async () => {
		useStore.getState().setUiPrefs({ showResourceMonitor: true });

		render(<ResourceMonitor />);

		await waitFor(() => expect(screen.getByText("CPU 12%")).toBeTruthy());
		expect(screen.getByText("4.5GB")).toBeTruthy();
		expect(screen.getByText("세션 0")).toBeTruthy();
		expect(screen.getByText("120GB")).toBeTruthy();
	});

	it("볼륨을 못 재면 디스크 항목만 빠진다", async () => {
		systemResourcesMock.mockResolvedValue({
			cpuPercent: 5,
			memoryUsedBytes: 1024 ** 3,
			memoryTotalBytes: 8 * 1024 ** 3,
			diskFreeBytes: null,
			diskTotalBytes: null,
		});
		useStore.getState().setUiPrefs({ showResourceMonitor: true });

		render(<ResourceMonitor />);

		await waitFor(() => expect(screen.getByText("CPU 5%")).toBeTruthy());
		expect(screen.queryByText(/GB \/ /)).toBeNull();
	});

	it("표본이 실패해도 위젯이 깨지지 않는다", async () => {
		systemResourcesMock.mockRejectedValue(new Error("nope"));
		useStore.getState().setUiPrefs({ showResourceMonitor: true });

		render(<ResourceMonitor />);

		await waitFor(() => expect(systemResourcesMock).toHaveBeenCalled());
		expect(screen.queryByText(/CPU/)).toBeNull();
	});
});
