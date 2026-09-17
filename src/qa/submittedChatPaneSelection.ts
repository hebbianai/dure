import { createDockview } from "dockview-react";
import { prepareManagedAgentInput } from "@/lib/sessions/managed/managedAgentInput";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";

export const submittedChatPaneSelectionCases = [
	"neutral",
	"reused-id",
	"legacy",
	"wrong-agent",
	"non-agent",
	"malformed-reference",
	"missing-reference",
	"absent",
	"ambiguous",
	"saved",
	"restored",
	"headless",
] as const;

/** The same admission observation runs in Vitest and hidden native WebViews.
 * Preparation only: no provider, request claim or native input is invoked. */
export function probeSubmittedChatPaneSelection(
	scenario: (typeof submittedChatPaneSelectionCases)[number],
) {
	const previous = useStore.getState();
	const agent = agentFixture({
		id: "qa-chat-input-agent",
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "qa-chat-input-conversation",
		},
	});
	const desktopId = `qa-chat-input-${scenario}`;
	const panelId = ["neutral", "absent", "saved", "restored"].includes(scenario)
		? "pane:stable-chat-slot"
		: scenario === "reused-id"
			? "launcher:original-slot"
			: `agent:${agent.id}`;
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
	try {
		useStore.setState({
			agents: [agent],
			layouts: {},
			activeSpaceId: "unrelated",
		});
		if (scenario !== "absent") {
			api.addPanel({
				id: panelId,
				component:
					scenario === "non-agent" || scenario === "headless"
						? "terminal"
						: "agent",
				params:
					["legacy", "missing-reference"].includes(scenario)
						? {}
						: {
								agentRef:
									scenario === "malformed-reference"
										? {}
										: {
												agentId:
													scenario === "wrong-agent" ? "other" : agent.id,
											},
							},
			});
		}
		api.addPanel({ id: "unrelated-editor", component: "editor" });
		const layout = api.toJSON();
		if (scenario === "legacy") {
			api.fromJSON(
				normalizePersistedPaneLayout(layout) as ReturnType<typeof api.toJSON>,
			);
		} else if (scenario === "saved") {
			useStore.setState({ layouts: { [desktopId]: layout } });
			unregisterDockview(desktopId, api);
		} else if (scenario === "restored") {
			api.fromJSON(JSON.parse(JSON.stringify(layout)));
		} else if (scenario === "ambiguous") {
			useStore.setState({ layouts: { [`${desktopId}-duplicate`]: layout } });
		}
		const before = api.toJSON();
		let errorCode: string | undefined;
		let prepared: ReturnType<typeof prepareManagedAgentInput> | undefined;
		try {
			prepared = prepareManagedAgentInput({
				name: agent.id,
				targetPanelId: scenario === "headless" ? undefined : panelId,
				text: "fixture input is only prepared",
			});
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			errorCode = String(error.code);
		}
		const expectedError = [
			"wrong-agent",
			"non-agent",
			"malformed-reference",
			"missing-reference",
		].includes(scenario)
			? "pane_changed"
			: scenario === "absent"
				? "invalid_request"
				: scenario === "ambiguous"
					? "pane_ambiguous"
					: undefined;
		if (
			errorCode !== expectedError ||
			(!expectedError &&
				(prepared?.kind !== "structured" || prepared.agent !== agent))
		)
			throw new Error(
				`${scenario}: unexpected admission ${JSON.stringify({ errorCode, kind: prepared?.kind })}`,
			);
		if (
			useStore.getState().activeSpaceId !== "unrelated" ||
			useStore.getState().agents[0] !== agent ||
			JSON.stringify(api.toJSON()) !== JSON.stringify(before)
		)
			throw new Error(
				`${scenario}: input admission changed selection, layout or Agent`,
			);
		return {
			scenario,
			errorCode,
			admitted: Boolean(prepared),
			preserved: true,
		};
	} finally {
		unregisterDockview(desktopId, api);
		api.dispose();
		container.remove();
		useStore.setState({
			agents: previous.agents,
			layouts: previous.layouts,
			activeSpaceId: previous.activeSpaceId,
		});
	}
}
