// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useManagedAgentTerminalFallback } from "@/components/agents/useManagedAgentTerminalFallback";
import { replaceManagedAgentPaneWithShell } from "@/lib/sessions/managed/managedAgentPaneToShell";
import type { HmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import {
	hmuxSessionMetadataFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

vi.mock("@/lib/sessions/managed/managedAgentPaneToShell", () => ({
	replaceManagedAgentPaneWithShell: vi.fn(),
}));

const binding: HmuxManagedPaneBindingV1 = {
	schemaVersion: 1,
	runtime: "hmux_managed_v1",
	source: "local",
	hostId: "local",
	sessionId: "session-uiux-dev",
	workspaceId: "workspace-uiux-dev",
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(replaceManagedAgentPaneWithShell).mockReset();
	useStore.setState({ agentActivity: {}, hmuxSessionMetadata: {} });
});

describe("useManagedAgentTerminalFallback", () => {
	it("keeps a local managed Agent pane after authoritative exit", () => {
		const panelApi = { id: "agent:uiux-dev", close: vi.fn() } as unknown as IDockviewPanel["api"];
		const containerApi = {} as DockviewApi;
		const onError = vi.fn();
		const rendered = renderHook(() =>
			useManagedAgentTerminalFallback({
				agentId: "agent-uiux-dev",
				activity: "working",
				binding,
				containerApi,
				panelApi,
				cwd: "/repo",
				desktopId: "desktop-uiux",
				onError,
			}),
		);

		act(() => {
			rendered.result.current.onHmuxSessionExit();
		});

		expect(replaceManagedAgentPaneWithShell).not.toHaveBeenCalled();
		expect(useStore.getState().agentActivity["agent-uiux-dev"]).toBe("exited");
		expect(rendered.result.current.authoritativeExit).toBe(true);
		expect(onError).not.toHaveBeenCalled();
	});

	it("runs the exit fallback from the Host's census with no terminal attached", () => {
		const fence = stopFenceFixture();
		const fenced = managedBindingFixture({ stopFence: fence });
		const exitedSummary = {
			stopFence: fence,
			terminalEpoch: fence.terminalEpoch,
			lifecycle: "exited" as const,
			health: "exited" as const,
		};
		const rendered = renderHook(
			({ activity }) =>
				useManagedAgentTerminalFallback({
					agentId: "agent-card",
					activity,
					binding: fenced,
					containerApi: {} as DockviewApi,
					panelApi: { id: "agent:card", close: vi.fn() } as unknown as IDockviewPanel["api"],
					cwd: "/repo",
					onError: vi.fn(),
				}),
			{ initialProps: { activity: "working" as "working" | "exited" } },
		);
		// An exit of another generation of the same session says nothing.
		act(() =>
			useStore.setState({
				hmuxSessionMetadata: hmuxSessionMetadataFixture({
					...exitedSummary,
					stopFence: { ...fence, terminalEpoch: "terminal-epoch-0" },
					terminalEpoch: "terminal-epoch-0",
				}),
			}),
		);
		expect(rendered.result.current.authoritativeExit).toBe(false);
		expect(useStore.getState().agentActivity["agent-card"]).toBeUndefined();

		act(() =>
			useStore.setState({
				hmuxSessionMetadata: hmuxSessionMetadataFixture(exitedSummary),
			}),
		);
		rendered.rerender({ activity: "exited" });
		expect(useStore.getState().agentActivity["agent-card"]).toBe("exited");
		expect(rendered.result.current.authoritativeExit).toBe(true);
	});

	it("records a legacy exit without replacing the pane", () => {
		const rendered = renderHook(() =>
			useManagedAgentTerminalFallback({
				agentId: "agent-uiux-dev",
				activity: "working",
				binding: undefined,
				containerApi: {} as DockviewApi,
				panelApi: { id: "agent:uiux-dev", close: vi.fn() } as unknown as IDockviewPanel["api"],
				cwd: "/repo",
				onError: vi.fn(),
			}),
		);

		act(() => rendered.result.current.onHmuxSessionExit());

		expect(useStore.getState().agentActivity["agent-uiux-dev"]).toBe("exited");
		expect(replaceManagedAgentPaneWithShell).not.toHaveBeenCalled();
	});

	it("turns Ctrl-C into an immediate managed shell escape when recovery reports a stale Host", async () => {
		vi.mocked(replaceManagedAgentPaneWithShell).mockResolvedValue({} as never);
		const preventDefault = vi.fn();
		const stopPropagation = vi.fn();
		const rendered = renderHook(() =>
			useManagedAgentTerminalFallback({
				agentId: "agent-uiux-dev",
				activity: "working",
				binding,
				containerApi: {} as DockviewApi,
				panelApi: { id: "agent:uiux-dev", close: vi.fn() } as unknown as IDockviewPanel["api"],
				cwd: "/repo",
				recoveryAvailable: true,
				onError: vi.fn(),
			}),
		);

		act(() => {
			rendered.result.current.onTerminalKeyDown({
				key: "c",
				ctrlKey: true,
				altKey: false,
				metaKey: false,
				preventDefault,
				stopPropagation,
			} as never);
		});

		await waitFor(() => expect(replaceManagedAgentPaneWithShell).toHaveBeenCalledOnce());
		expect(preventDefault).toHaveBeenCalledOnce();
		expect(stopPropagation).toHaveBeenCalledOnce();
	});

	it("suppresses both Ctrl-C and direct shell replacement during a runtime transition", async () => {
		vi.mocked(replaceManagedAgentPaneWithShell).mockResolvedValue({} as never);
		const preventDefault = vi.fn();
		const stopPropagation = vi.fn();
		const rendered = renderHook(
			({ disabled }: { disabled: boolean }) =>
				useManagedAgentTerminalFallback({
					agentId: "agent-uiux-dev",
					activity: "working",
					binding,
					containerApi: {} as DockviewApi,
					panelApi: { id: "agent:uiux-dev", close: vi.fn() } as unknown as IDockviewPanel["api"],
					cwd: "/repo",
					recoveryAvailable: true,
					disabled,
					onError: vi.fn(),
				}),
			{ initialProps: { disabled: true } },
		);

		await act(async () => rendered.result.current.onOpenShell?.());
		act(() => {
			rendered.result.current.onTerminalKeyDown({
				key: "c",
				ctrlKey: true,
				altKey: false,
				metaKey: false,
				preventDefault,
				stopPropagation,
			} as never);
		});
		expect(replaceManagedAgentPaneWithShell).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();

		rendered.rerender({ disabled: false });
		act(() => {
			rendered.result.current.onTerminalKeyDown({
				key: "c",
				ctrlKey: true,
				altKey: false,
				metaKey: false,
				preventDefault,
				stopPropagation,
			} as never);
		});
		await waitFor(() =>
			expect(replaceManagedAgentPaneWithShell).toHaveBeenCalledOnce(),
		);
	});

	it("owns the parent runtime transition for the full shell replacement", async () => {
		let finishReplacement: (() => void) | undefined;
		vi.mocked(replaceManagedAgentPaneWithShell).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishReplacement = () => resolve({} as never);
				}),
		);
		const transitions: boolean[] = [];
		const rendered = renderHook(() =>
			useManagedAgentTerminalFallback({
				agentId: "agent-uiux-dev",
				activity: "working",
				binding,
				containerApi: {} as DockviewApi,
				panelApi: { id: "agent:uiux-dev", close: vi.fn() } as unknown as IDockviewPanel["api"],
				cwd: "/repo",
				onTransitioningChange: (transitioning) =>
					transitions.push(transitioning),
				onError: vi.fn(),
			}),
		);

		let replacement: Promise<void> | undefined;
		act(() => {
			replacement = rendered.result.current.onOpenShell?.();
		});
		expect(transitions).toEqual([true]);
		expect(rendered.result.current.openingShell).toBe(true);
		await act(async () => {
			finishReplacement?.();
			await replacement;
		});
		expect(transitions).toEqual([true, false]);
		expect(rendered.result.current.openingShell).toBe(false);
	});
});
