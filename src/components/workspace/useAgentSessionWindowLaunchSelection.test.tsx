// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentLaunchSelectionOwner } from "@/components/agents/AgentLaunchSelectionControls";
import type { AgentLaunchSelectionPresentationV1 } from "@/lib/agents/agentLaunchSelectionSurface";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { executeAgentSessionLaunchSelectionStep } from "@/lib/workspace/window/agentSessionWindowLaunchSelection";
import { codexModelCatalog } from "@/test/providerModelCatalogFixtures";

const mirror = vi.hoisted(() => ({
	follow: undefined as
		| undefined
		| ((presentation: AgentLaunchSelectionPresentationV1 | null) => void),
	run: vi.fn(async (_command: unknown) => {}),
}));
vi.mock("@/lib/workspace/window/agentSessionWindowPaneMirrors", () => ({
	agentSessionWindowLaunchSelection: (route: { sourcePaneOwnerId?: string }) =>
		route.sourcePaneOwnerId
			? {
					watch: (
						follow: (
							presentation: AgentLaunchSelectionPresentationV1 | null,
						) => void,
					) => {
						mirror.follow = follow;
						return () => {
							mirror.follow = undefined;
						};
					},
					run: mirror.run,
				}
			: undefined,
}));

import {
	useAgentSessionLaunchSelectionPublication,
	useAgentSessionWindowLaunchSelection,
} from "./useAgentSessionWindowLaunchSelection";

const PANE = "agent:agent-1";

function launchView(
	patch: Partial<AgentRuntimeLaunchSelectionView> = {},
): AgentRuntimeLaunchSelectionView {
	return {
		ownerKey: "fixture-runtime",
		paneId: PANE,
		loaded: true,
		hydrationError: false,
		model: "gpt-5.6-sol",
		effort: "high",
		permissionMode: "default",
		switching: false,
		error: null,
		switchSelection: vi.fn(async () => ({ outcome: "applied" as const })),
		retryHydration: vi.fn(),
		dismissError: vi.fn(),
		...patch,
	};
}

function SourcePane({ launch }: { launch: AgentRuntimeLaunchSelectionView }) {
	const surface = useAgentLaunchSelectionOwner({
		provider: "codex",
		launch,
		catalog: codexModelCatalog,
		busy: false,
	});
	useAgentSessionLaunchSelectionPublication(PANE, surface);
	return null;
}

const largeWindow = {
	panelId: PANE,
	replyWindowLabel: "win-large-view",
	action: "launch_selection" as const,
};

afterEach(async () => {
	cleanup();
	await executeAgentSessionLaunchSelectionStep({
		...largeWindow,
		step: "unwatch",
	});
	mirror.run.mockReset();
});

describe("the source pane's launch pills in its large window", () => {
	it("are the pane's own pills: a large-window command reaches the pane's controller", async () => {
		const launch = launchView();
		const rendered = render(<SourcePane launch={launch} />);

		await expect(
			executeAgentSessionLaunchSelectionStep({ ...largeWindow, step: "watch" }),
		).resolves.toMatchObject({
			kind: "launch_selection_watched",
			presentation: { model: "gpt-5.6-sol", effort: "high" },
		});
		await act(() =>
			executeAgentSessionLaunchSelectionStep({
				...largeWindow,
				step: "run",
				command: { kind: "select", field: "effort", value: "max" },
			}),
		);
		expect(launch.switchSelection).toHaveBeenCalledOnce();
		const [update] = vi.mocked(launch.switchSelection).mock.calls[0];
		expect(
			update({
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "default",
			}),
		).toEqual({
			model: "gpt-5.6-sol",
			effort: "max",
			permissionMode: "default",
		});

		// A pane without launch pills (not on a managed Host) publishes none.
		rendered.unmount();
		await expect(
			executeAgentSessionLaunchSelectionStep({
				...largeWindow,
				step: "run",
				command: { kind: "dismiss_error" },
			}),
		).rejects.toMatchObject({ code: "client_launch_selection_unavailable" });
	});

	it("show a command the large window could not deliver, until dismissed", async () => {
		const { result } = renderHook(() =>
			useAgentSessionWindowLaunchSelection({
				agentId: "agent-1",
				sourceWindowLabel: "win-workspace",
				sourcePaneOwnerId: `desktop-1:${PANE}`,
			}),
		);
		expect(result.current).toBeUndefined();
		const published = {
			loaded: true,
			hydrationError: false,
			model: "gpt-5.6-sol",
			effort: null,
			permissionMode: "default",
			switching: false,
			error: null,
			observedModel: null,
			catalog: { offered: true, status: "idle" },
			modelOptions: [],
			effortOptions: [],
			permissionOptions: [],
		} satisfies AgentLaunchSelectionPresentationV1;
		act(() => mirror.follow?.(published));
		expect(result.current?.presentation).toEqual(published);

		mirror.run.mockRejectedValueOnce(
			new Error("source window command response timed out"),
		);
		await act(() =>
			result.current?.run({ kind: "select", field: "model", value: null }),
		);
		expect(result.current?.presentation.error).toBe(
			"source window command response timed out",
		);

		await act(() => result.current?.run({ kind: "dismiss_error" }));
		expect(result.current?.presentation).toEqual(published);
		// Dismissing a local delivery failure sends nothing to the source pane.
		expect(mirror.run).toHaveBeenCalledOnce();
	});

	it("are absent while the large window does not know its source pane", () => {
		const { result } = renderHook(() =>
			useAgentSessionWindowLaunchSelection({
				agentId: "agent-1",
				sourceWindowLabel: "win-workspace",
			}),
		);
		expect(result.current).toBeUndefined();
		expect(mirror.follow).toBeUndefined();
	});
});
