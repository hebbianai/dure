import { describe, expect, it, vi } from "vitest";
import { codexModelCatalog } from "@/test/providerModelCatalogFixtures";
import {
	type AgentLaunchSelectionCommand,
	agentLaunchSelectionCommandRunner,
	agentLaunchSelectionPresentation,
	parseAgentLaunchSelectionCommand,
	parseAgentLaunchSelectionPresentation,
} from "./agentLaunchSelectionSurface";
import type { AgentRuntimeLaunchSelectionView } from "./agentRuntimeLaunchSelection";
import { agentRuntimeSettingActions } from "./agentRuntimeSettingActions";

function launchView(
	patch: Partial<AgentRuntimeLaunchSelectionView> = {},
): AgentRuntimeLaunchSelectionView {
	return {
		ownerKey: "fixture-runtime",
		paneId: "agent:agent-1",
		loaded: true,
		hydrationError: false,
		model: "gpt-5.6-sol",
		effort: "high",
		permissionMode: "skip_permissions",
		switching: false,
		error: null,
		switchSelection: vi.fn(async () => ({ outcome: "applied" as const })),
		retryHydration: vi.fn(),
		dismissError: vi.fn(),
		...patch,
	};
}

function presentationOf(launch: AgentRuntimeLaunchSelectionView) {
	const settings = agentRuntimeSettingActions({
		provider: "codex",
		launch,
		models: codexModelCatalog,
		observedModel: null,
		busy: false,
	});
	return agentLaunchSelectionPresentation({
		launch,
		settings,
		observedModel: null,
		catalog: { offered: true, status: "idle" },
	});
}

describe("launch selection presentation", () => {
	it("carries the pane's selection, pending change and menus as plain data", () => {
		const presentation = presentationOf(
			launchView({
				error: "backend refused",
				errorMessage: "The switch failed.",
				pending: {
					requestId: "request-1",
					selection: {
						model: "gpt-5.6-sol",
						effort: "max",
						permissionMode: "default",
					},
				},
			}),
		);

		expect(presentation).toMatchObject({
			loaded: true,
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "skip_permissions",
			error: "backend refused",
			errorMessage: "The switch failed.",
			pending: {
				requestId: "request-1",
				selection: { effort: "max", permissionMode: "default" },
			},
			catalog: { offered: true, status: "idle" },
		});
		expect(presentation.modelOptions.map((option) => option.value)).toEqual(
			codexModelCatalog.map((model) => model.value),
		);
		expect(presentation.effortOptions.length).toBeGreaterThan(0);
		// Launch overrides are the pane's execution detail, not presentation.
		for (const option of presentation.permissionOptions) {
			expect(Object.keys(option).sort()).toEqual(
				option.tone ? ["label", "tone", "value"] : ["label", "value"],
			);
		}
		// What another window receives is exactly what the pane renders.
		expect(
			parseAgentLaunchSelectionPresentation(
				JSON.parse(JSON.stringify(presentation)),
			),
		).toEqual(presentation);
	});

	it("refuses a malformed presentation from another window", () => {
		const presentation = presentationOf(launchView());
		for (const malformed of [
			{ ...presentation, permissionMode: "everything" },
			{ ...presentation, loaded: "yes" },
			{ ...presentation, catalog: { offered: true, status: "busy" } },
			{ ...presentation, modelOptions: [{ value: "", label: "Empty" }] },
			{ ...presentation, effortOptions: [{ value: "high", label: 3 }] },
			{
				...presentation,
				permissionOptions: Array.from({ length: 257 }, (_, index) => ({
					value: `mode-${index}`,
					label: "Mode",
				})),
			},
			{
				...presentation,
				pending: {
					requestId: "request-1",
					selection: { model: null, effort: null, permissionMode: "all" },
				},
			},
			null,
		]) {
			expect(parseAgentLaunchSelectionPresentation(malformed)).toBeUndefined();
		}
	});
});

describe("launch selection commands", () => {
	it("runs each pill command on the same settings handler the pane publishes", async () => {
		const launch = launchView();
		const settings = agentRuntimeSettingActions({
			provider: "codex",
			launch,
			models: codexModelCatalog,
			observedModel: null,
			busy: false,
		});
		const actions = Object.fromEntries(
			Object.keys(settings.actions).map((name) => [
				name,
				vi.fn(async () => ({ outcome: "applied" as const })),
			]),
		) as unknown as typeof settings.actions;
		const run = agentLaunchSelectionCommandRunner(
			{ ...settings, actions },
			launch,
		);
		const commands: AgentLaunchSelectionCommand[] = [
			{ kind: "select", field: "model", value: "gpt-5.6-sol" },
			{ kind: "select", field: "effort", value: null },
			{ kind: "select", field: "permissionMode", value: "default" },
			{ kind: "apply_pending" },
			{ kind: "cancel_pending" },
			{ kind: "load_catalog" },
			{ kind: "retry_hydration" },
			{ kind: "dismiss_error" },
		];
		for (const command of commands) await run(command);

		expect(actions["settings.model"]).toHaveBeenCalledWith({
			value: "gpt-5.6-sol",
		});
		expect(actions["settings.effort"]).toHaveBeenCalledWith({ value: null });
		expect(actions["settings.permission"]).toHaveBeenCalledWith({
			value: "default",
		});
		expect(actions["settings.applyPending"]).toHaveBeenCalledOnce();
		expect(actions["settings.cancelPending"]).toHaveBeenCalledOnce();
		expect(actions["settings.catalog"]).toHaveBeenCalledOnce();
		expect(launch.retryHydration).toHaveBeenCalledOnce();
		expect(launch.dismissError).toHaveBeenCalledOnce();
	});

	it("accepts only well-formed commands from another window", () => {
		expect(
			parseAgentLaunchSelectionCommand({
				kind: "select",
				field: "effort",
				value: "max",
				extra: true,
			}),
		).toEqual({ kind: "select", field: "effort", value: "max" });
		expect(parseAgentLaunchSelectionCommand({ kind: "apply_pending" })).toEqual(
			{ kind: "apply_pending" },
		);
		for (const malformed of [
			{ kind: "select", field: "provider", value: "codex" },
			{ kind: "select", field: "model", value: 4 },
			{ kind: "select", field: "model" },
			{ kind: "restart" },
			"apply_pending",
		]) {
			expect(parseAgentLaunchSelectionCommand(malformed)).toBeUndefined();
		}
	});
});
