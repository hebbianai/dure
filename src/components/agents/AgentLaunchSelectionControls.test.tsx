// @vitest-environment jsdom

import { codexModelCatalog, claudeModelCatalog } from "@/test/providerModelCatalogFixtures";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSelect } from "@/test/select";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { useAgentLaunchControlsPresentation } from "@/components/agents/useAgentToolbarControls";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import { invokePaneAction, paneActionSnapshot, registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";

function launchView(
	patch: Partial<AgentRuntimeLaunchSelectionView> = {},
): AgentRuntimeLaunchSelectionView {
	return {
		ownerKey: "fixture-runtime",
		loaded: false,
		hydrationError: false,
		model: null,
		effort: null,
		permissionMode: "default",
		switching: false,
		error: null,
		switchSelection: vi.fn(),
		retryHydration: vi.fn(),
		dismissError: vi.fn(),
		...patch,
	};
}


describe("AgentLaunchSelectionControls", () => {
	afterEach(cleanup);
	it("exposes the mounted menu choices and calls the same selection handler from external actions", async () => {
		const receipt = { outcome: "applied" as const, value: { conversationId: "original", selectionRevision: 4 } };
		const switchSelection = vi.fn(async () => receipt);
		const launch = launchView({ paneId: "agent:control-test", loaded: true, model: "gpt-5.6-sol", effort: "high", selectionRevision: 3, conversationId: "original", switchSelection });
		const remove = registerPaneActions({ owner: {}, paneId: launch.paneId as string, status: "idle", actions: {} });
		try {
			render(<AgentLaunchSelectionControls provider="codex" launch={launch} catalog={codexModelCatalog} busy={false} />);
			const definitions = paneActionSnapshot(launch.paneId as string)?.actionDefinitions;
			expect(definitions?.["settings.effort"].current).toEqual({ value: "high", selectionRevision: 3, conversationId: "original" });
			openSelect(screen.getByRole("combobox", { name: t("agents.chat.effortLabel") }));
			fireEvent.click(screen.getByRole("option", { name: "Max" }));
			await act(async () => {
				expect(await invokePaneAction(launch.paneId as string, "settings.effort", { value: "max", expectedSourceRevision: 3, expectedConversationId: "original" })).toMatchObject({ result: receipt });
			});
			expect(switchSelection).toHaveBeenCalledTimes(2);
			const source = { model: "gpt-5.6-sol", effort: "high", permissionMode: "skip_permissions" as const };
			const calls = vi.mocked(launch.switchSelection).mock.calls;
			expect(calls[0][0](source)).toEqual(calls[1][0](source));
			expect(calls[1][1]).toEqual({ expectedSourceRevision: 3, expectedConversationId: "original" });
		} finally { remove(); }
	});
	it("offers only supported permissions for a Pi pane", () => {
		render(<AgentLaunchSelectionControls provider="pi" launch={launchView({ loaded: true })} busy={false} />);
		openSelect(screen.getByRole("combobox", { name: t("agents.chat.permissionLabel") }));
		expect(screen.getByRole("option", { name: t("agents.chat.permissionDefault") })).toBeTruthy();
		expect(screen.queryByRole("option", { name: t("agents.chat.permissionAutoEdit") })).toBeNull();
		expect(screen.queryByRole("option", { name: t("agents.chat.permissionSkip") })).toBeNull();
	});

	it("keeps loaded Skip approvals hidden in Basic without changing permissions", () => {
		const previousPrefs = useStore.getState().uiPrefs;
		const launch = launchView({
			loaded: true,
			permissionMode: "skip_permissions",
		});
		function Toolbar() {
			const presentation = useAgentLaunchControlsPresentation(launch);
			return (
				<AgentLaunchSelectionControls
					provider="codex"
					launch={launch}
					busy={false}
					presentation={presentation}
				/>
			);
		}
		try {
			useStore.setState({
				uiPrefs: { ...previousPrefs, interfaceMode: "basic" },
			});
			render(<Toolbar />);
			const permissionButton = { name: t("agents.chat.permissionLabel") };
			expect(screen.queryByRole("combobox", permissionButton)).toBeNull();
			act(() => useStore.setState({
				uiPrefs: { ...previousPrefs, interfaceMode: "pro" },
			}));
			expect(screen.getByRole("combobox", permissionButton)).toBeTruthy();
			act(() => useStore.setState({
				uiPrefs: { ...previousPrefs, interfaceMode: "basic" },
			}));
			expect(screen.queryByRole("combobox", permissionButton)).toBeNull();
			expect(launch.permissionMode).toBe("skip_permissions");
			expect(launch.switchSelection).not.toHaveBeenCalled();
		} finally {
			cleanup();
			useStore.setState({ uiPrefs: previousPrefs });
		}
	});

	it("refreshes a provider-owned catalog when the model menu opens", async () => {
		const load = vi.fn().mockResolvedValue([
			{ value: "gpt-next", displayName: "Provider Next", supportsEffort: true,
				supportedEffortLevels: ["deep"] },
		]);
		render(<AgentLaunchSelectionControls provider="codex" launch={launchView()}
			busy={false} {...{ catalogSource: { key: "codex:default", load } }} />);
		expect(load).not.toHaveBeenCalled();
		openSelect(screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }));
		await waitFor(() => expect(screen.queryByText("Provider Next")).not.toBeNull());
		expect(screen.queryByText("GPT-5.6 Sol")).toBeNull();
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		load.mockResolvedValue([{ value: "gpt-later", displayName: "Provider Later",
			supportsEffort: false, supportedEffortLevels: [] }]);
		openSelect(screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }));
		await waitFor(() => expect(screen.queryByText("Provider Later")).not.toBeNull());
		expect(screen.queryByText("Provider Next")).toBeNull();
	});

	it("derives an unloaded model change from the exact action-time source", () => {
		const launch = launchView({
			model: "gpt-5.6-sol",
			effort: "ultra",
			permissionMode: "skip_permissions",
		});
		render(
			<AgentLaunchSelectionControls
				provider="codex"
				catalog={codexModelCatalog}
				launch={launch}
				busy={false}
			/>,
		);
		const modelTrigger = screen.getByRole("combobox", {
			name: t("agents.chat.modelLabel"),
		});
		expect(screen.queryByText("GPT-5.6 Sol")).toBeNull();
		// Nothing known yet: the pill reads as its label, not a bare dash.
		expect(screen.getByText(t("agents.chat.modelLabel"))).toBeTruthy();
		openSelect(modelTrigger);
		fireEvent.click(screen.getByText("GPT-5.6 Luna"));

		const update = vi.mocked(launch.switchSelection).mock.calls[0]?.[0];
		expect(typeof update).toBe("function");
		if (typeof update !== "function") throw new Error("expected updater");
		expect(
			update({
				model: "gpt-5.6-sol",
				effort: "ultra",
				permissionMode: "skip_permissions",
			}),
		).toEqual({
			model: "gpt-5.6-luna",
			effort: null,
			permissionMode: "skip_permissions",
		});
	});

	it("returns the model to Auto while preserving only default-safe effort", () => {
		const launch = launchView({
			loaded: true,
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
		render(
			<AgentLaunchSelectionControls
				provider="codex"
				catalog={codexModelCatalog}
				launch={launch}
				busy={false}
			/>,
		);

		openSelect(screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }));
		fireEvent.click(screen.getByText(t("agents.quickDispatch.autoModel")));

		const update = vi.mocked(launch.switchSelection).mock.calls[0]?.[0];
		if (typeof update !== "function") throw new Error("expected updater");
		expect(
			update({
				model: "gpt-5.6-sol",
				effort: "xhigh",
				permissionMode: "auto_edit",
			}),
		).toEqual({
			model: null,
			effort: "xhigh",
			permissionMode: "auto_edit",
		});
		expect(
			update({
				model: "gpt-5.6-sol",
				effort: "ultra",
				permissionMode: "skip_permissions",
			}),
		).toEqual({
			model: null,
			effort: null,
			permissionMode: "skip_permissions",
		});
	});

	it("returns effort to Auto without changing the other source fields", () => {
		const launch = launchView({
			loaded: true,
			model: "gpt-5.6-sol",
			effort: "ultra",
			permissionMode: "skip_permissions",
		});
		render(
			<AgentLaunchSelectionControls
				provider="codex"
				catalog={codexModelCatalog}
				launch={launch}
				busy={false}
			/>,
		);

		openSelect(screen.getByRole("combobox", { name: t("agents.chat.effortLabel") }));
		fireEvent.click(screen.getByText(t("agents.quickDispatch.autoEffort")));

		const update = vi.mocked(launch.switchSelection).mock.calls[0]?.[0];
		if (typeof update !== "function") throw new Error("expected updater");
		expect(
			update({
				model: "gpt-5.6-sol",
				effort: "ultra",
				permissionMode: "skip_permissions",
			}),
		).toEqual({
			model: "gpt-5.6-sol",
			effort: null,
			permissionMode: "skip_permissions",
		});
	});

	it("treats the already selected launch value as a semantic no-op", () => {
		const launch = launchView({
			loaded: true,
			model: "gpt-5.6-sol",
			effort: "xhigh",
			permissionMode: "default",
		});
		render(
			<AgentLaunchSelectionControls
				provider="codex"
				catalog={codexModelCatalog}
				launch={launch}
				busy={false}
			/>,
		);

		openSelect(screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }));
		fireEvent.click(
			screen.getByRole("option", { name: "GPT-5.6 Sol" }),
		);

		expect(launch.switchSelection).not.toHaveBeenCalled();
	});

	it("shows a localized failure instead of a raw backend code", () => {
		const rawCode = "agent_runtime_structured_profile_unavailable";
		const dismissError = vi.fn();
		render(
			<AgentLaunchSelectionControls
				provider="codex"
				catalog={codexModelCatalog}
				launch={launchView({ error: rawCode, dismissError })}
				busy={false}
			/>,
		);

		expect(screen.queryByText(rawCode)).toBeNull();
		expect(screen.getByTitle(rawCode).textContent).toBe(
			t("agents.runtime.switchFailed"),
		);
		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
		expect(dismissError).toHaveBeenCalledOnce();
	});

	it("keeps launch controls available beside a failed hydration retry", () => {
		const retryHydration = vi.fn();
		const launch = launchView({ hydrationError: true, retryHydration });
		render(
			<AgentLaunchSelectionControls
				provider="claude"
				catalog={claudeModelCatalog}
				launch={launch}
				busy={false}
			/>,
		);

		expect(
			screen.getByText(t("agents.runtime.launchSelectionUnavailable")),
		).toBeTruthy();
		expect(
			screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: t("common.retry") }));

		expect(retryHydration).toHaveBeenCalledOnce();
		expect(launch.switchSelection).not.toHaveBeenCalled();
	});
});
