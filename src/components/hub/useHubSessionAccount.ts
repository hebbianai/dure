/**
 * Answering a phone that asked about, or asked to change, a session's account.
 *
 * The decisions are [`createHubSessionAccountAnswerer`]'s; this hook supplies
 * the parts that need a running window — the store, the shared usage
 * snapshot, and the account selector's own transition.
 *
 * # Only the main window
 *
 * Every window hears the event, and a switch *writes*: two windows answering
 * would be two restarts from one press. The same rule `useHubStartAgent`
 * follows for the same reason.
 *
 * # The source pane
 *
 * The selector passes the pane it sits in. A phone has no pane, so this hook
 * passes the pane that presents the agent when one exists, and otherwise the
 * agent's canonical pane id, which the transition treats as an unmounted
 * presentation — the agent and source fences still bind the switch.
 */

import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { requestAgentCredentialTransition } from "@/lib/agents/agentCredentialTransition";
import { createHubSessionAccountAnswerer } from "@/lib/hub/sessionAccountBridge";
import type { HubSessionAccountDispatch } from "@/lib/hub/sessionAccountWire";
import { usageRecent } from "@/lib/ipc";
import { hubSessionAccountResult } from "@/lib/ipc/system";
import { resolveLegacyAgentPaneTarget } from "@/lib/sessions/managed/managedAgentTarget";
import { paneHmuxSessionId } from "@/lib/spaces/hmuxSessionIdentity";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";
import type { Agent } from "@/types";

function sourcePanelId(agent: Agent): string {
	const panes = agentPaneLocations(
		useStore.getState().layouts,
		mountedDockviewEntries(),
	).filter((pane) => pane.agentId === agent.id);
	return panes.length === 1
		? panes[0].panelId
		: resolveLegacyAgentPaneTarget(agent).panelId;
}

export function useHubSessionAccount(): void {
	useEffect(() => {
		if (!isMainWindow()) return;
		const answer = createHubSessionAccountAnswerer({
			agentForSession: (sessionId) =>
				useStore
					.getState()
					.agents.find(
						(agent) =>
							paneHmuxSessionId({ kind: "agent" }, agent) === sessionId,
					),
			agentById: (agentId) =>
				useStore.getState().agents.find((agent) => agent.id === agentId),
			accounts: () => useStore.getState().accounts,
			// The window the desktop selector reads when it opens.
			usage: () => usageRecent(5),
			switchAccount: (agentId, targetCredentialId) => {
				const agent = useStore
					.getState()
					.agents.find((candidate) => candidate.id === agentId);
				if (!agent) {
					return Promise.reject(
						new Error("client_agent_runtime_transition_unavailable"),
					);
				}
				return requestAgentCredentialTransition({
					agentId,
					targetCredentialId,
					sourcePanelId: sourcePanelId(agent),
				});
			},
			report: hubSessionAccountResult,
		});
		let disposed = false;
		const pending = listen<HubSessionAccountDispatch>(
			"hub://session-account",
			(event) => {
				void answer(event.payload);
			},
		);
		void pending.then((unlisten) => {
			if (disposed) unlisten();
		});
		return () => {
			disposed = true;
			void pending.then((unlisten) => unlisten());
		};
	}, []);
}
