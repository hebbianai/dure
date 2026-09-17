import { createDockview } from "dockview-react";
import { resolveManagedAgentPresentationTarget } from "@/lib/sessions/managed/managedAgentRehostInspection";
import { onDesktopPrewarmRequest } from "@/lib/workspace/desktop/desktopPrewarm";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";
import { managedAgentFixture } from "@/test/agentFixtures";

export const managedAgentPaneReferenceCases = [
	"neutral",
	"reused-legacy-id",
	"different-agent",
	"absent",
	"ambiguous",
	"cold",
	"retargeted-during-prewarm",
	"unmatched-hint",
	"legacy",
	"missing-reference",
	"malformed-reference",
] as const;

/** Shared deterministic Dockview scenario for Vitest and hidden native WebViews.
 * Only disposable view/store fixtures are touched; no runtime command is sent. */
export async function probeManagedAgentPaneReference(
	scenario: (typeof managedAgentPaneReferenceCases)[number],
	exact = false,
) {
	const previous = useStore.getState();
	const agent = managedAgentFixture({ id: "qa-pane-reference-agent" });
	const desktopId = `qa-pane-reference-${scenario}`;
	const legacyId = `agent:${agent.id}`;
	const panelId = ["legacy", "missing-reference"].includes(scenario)
		? legacyId
		: "pane:stable-slot";
	const conflicting = [
		"reused-legacy-id",
		"different-agent",
		"malformed-reference",
		"missing-reference",
	].includes(scenario);
	const requestedPanelId = exact
		? conflicting
			? legacyId
			: scenario === "unmatched-hint"
				? "pane:missing"
				: panelId
		: undefined;
	const container = document.createElement("div");
	container.style.cssText =
		"position:fixed;width:900px;height:600px;visibility:hidden";
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(900, 600);
	registerDockview(desktopId, api);
	let stopPrewarm: (() => void) | undefined;
	try {
		useStore.setState({
			agents: [agent],
			layouts: {},
			activeSpaceId: "qa-unrelated-space",
			sessionCwd: {},
		});
		if (
			!["absent", "different-agent", "malformed-reference"].includes(scenario)
		) {
			api.addPanel({
				id: panelId,
				component: "agent",
				params:
					["legacy", "missing-reference"].includes(scenario)
						? {}
						: { agentRef: { agentId: agent.id } },
			});
		}
		if (scenario === "legacy") {
			api.fromJSON(
				normalizePersistedPaneLayout(api.toJSON()) as ReturnType<typeof api.toJSON>,
			);
		}
		if (scenario === "reused-legacy-id") {
			api.addPanel({
				id: legacyId,
				component: "terminal",
				params: { sessionId: agent.sessionId },
			});
		}
		if (
			["different-agent", "ambiguous", "malformed-reference"].includes(scenario)
		) {
			api.addPanel({
				id: legacyId,
				component: "agent",
				params: {
					agentRef:
						scenario === "malformed-reference"
							? {}
							: { agentId: scenario === "ambiguous" ? agent.id : "other" },
				},
			});
		}
		if (scenario === "cold" || scenario === "retargeted-during-prewarm") {
			const saved = api.toJSON();
			unregisterDockview(desktopId, api);
			useStore.setState({ layouts: { [desktopId]: saved } });
			api.clear();
			stopPrewarm = onDesktopPrewarmRequest((requested) => {
				if (requested !== desktopId) return;
				api.fromJSON(saved);
				if (scenario === "retargeted-during-prewarm") {
					api.getPanel(panelId)?.api.updateParameters({
						agentRef: { agentId: "other" },
					});
				}
				registerDockview(desktopId, api);
			});
		}
		const before = api.toJSON();
		let result:
			| Awaited<ReturnType<typeof resolveManagedAgentPresentationTarget>>
			| undefined;
		let errorCode: string | undefined;
		try {
			result = await resolveManagedAgentPresentationTarget(
				agent,
				useStore.getState(),
				requestedPanelId,
			);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			errorCode = String(error.code);
		}
		const absent =
			[
				"absent",
				"different-agent",
				"malformed-reference",
				"missing-reference",
				"retargeted-during-prewarm",
			].includes(scenario) ||
			(exact && scenario === "unmatched-hint");
		const expectedError =
			exact && (conflicting || scenario === "retargeted-during-prewarm")
				? "pane_changed"
				: scenario === "ambiguous" && !exact
					? "pane_ambiguous"
					: undefined;
		if (expectedError) {
			if (errorCode !== expectedError) {
				throw new Error(
					`${scenario}: expected ${expectedError}, got ${JSON.stringify({ result, errorCode })}`,
				);
			}
		} else if (
			errorCode ||
			result?.sourcePaneState !== (absent ? "absent" : "present") ||
			result.panelId !== (absent ? (requestedPanelId ?? legacyId) : panelId) ||
			result.desktopId !== (absent ? "qa-unrelated-space" : desktopId)
		) {
			throw new Error(
				`${scenario}: wrong presentation ${JSON.stringify({ result, errorCode })}`,
			);
		}
		if (
			useStore.getState().activeSpaceId !== "qa-unrelated-space" ||
			useStore.getState().agents[0] !== agent ||
			(!stopPrewarm && JSON.stringify(api.toJSON()) !== JSON.stringify(before))
		)
			throw new Error(
				`${scenario}: lookup changed selection, layout or runtime target`,
			);
		return { scenario, exact, result, errorCode, preserved: true };
	} finally {
		stopPrewarm?.();
		unregisterDockview(desktopId, api);
		api.dispose();
		container.remove();
		useStore.setState({
			agents: previous.agents,
			layouts: previous.layouts,
			activeSpaceId: previous.activeSpaceId,
			sessionCwd: previous.sessionCwd,
		});
	}
}
