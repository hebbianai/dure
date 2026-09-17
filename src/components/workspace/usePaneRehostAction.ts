/** Owns pane-header Host replacement actions. Refresh resumes an exact
 * conversation on a new Host; build rehost delegates to its shared workflow. */

import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { MutableRefObject } from "react";
import { useCallback } from "react";
import { usePaneActionPending } from "@/components/workspace/useNamedPaneAction";
import { usePaneActions } from "@/components/workspace/usePaneActions";
import { agentRuntimePaneActionOwnerKey } from "@/lib/agents/agentRuntimePaneAction";
import { ProviderConversationInputAuthorityError } from "@/lib/agents/providerConversationInputAuthority";
import {
	createManagedRefreshTiming,
	type ManagedCreateDiagnostics,
} from "@/lib/hmux/managed/managedRefreshTiming";
import { t } from "@/lib/i18n";
import { managedAgentBuildRehostSource } from "@/lib/sessions/managed/managedBuildRehostAuthority";
import { rehostManagedBuild } from "@/lib/sessions/managed/managedBuildRehostWorkflow";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { resumeExactManagedAgentPane } from "@/lib/sessions/managed/managedExactConversationResume";
import { hmuxPaneConversationId, type TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { terminalRuntimePresentationOwnerKey } from "@/lib/terminal/terminalRuntimePresentationOwner";
import { showErrorToast, showToast } from "@/lib/toast";
import { definePaneAction } from "@/lib/workspace/pane/paneAction";
import {
	beginPaneActionProgress,
	paneActionPending,
} from "@/lib/workspace/pane/paneActionRegistry";
import {
	executeLocalHmuxPaneRehost,
	type LocalHmuxPaneParameters,
	localHmuxRehostWorkflow,
} from "@/lib/workspace/pane/paneHmuxRehostAction";
import { requestManagedRecovery } from "@/lib/workspace/pane/paneMenuSignals";
import { type Agent, PROVIDERS } from "@/types";

export interface PaneRehostAction {
	/** 이 pane에 재호스트 경로가 하나라도 있는가 — 메뉴 항목의 존재 조건. */
	rehostAvailable: boolean;
	rehostBusy: boolean;
	rehostToCurrentBuild: () => void;
	refreshConversation: (() => void) | undefined;
	refreshDisabled: boolean;
}

export function usePaneRehostAction<Params extends LocalHmuxPaneParameters>({
	agent,
	api,
	commitWorkspaceLayout,
	hmuxBinding,
	paneParamsRef,
}: {
	agent: Agent | undefined;
	api: IDockviewPanelHeaderProps["api"];
	commitWorkspaceLayout: (() => boolean) | undefined;
	hmuxBinding: TerminalPaneBindingV1 | undefined;
	paneParamsRef: MutableRefObject<Params>;
}): PaneRehostAction {
	const rehostBusy = usePaneActionPending(api.id, "rehost");
	const localPaneRehost = agent
		? undefined
		: localHmuxRehostWorkflow(hmuxBinding);
	const buildRehostSource =
		agent && hmuxBinding?.runtime === "hmux_managed_v1"
			? managedAgentBuildRehostSource(agent)
			: hmuxBinding?.runtime === "hmux_managed_v1" &&
					hmuxBinding.source === "ssh"
				? hmuxBinding
				: undefined;
	const refreshAvailable = Boolean(
		agent &&
			buildRehostSource &&
			hmuxBinding?.source === "local" &&
			PROVIDERS[agent.provider].resumeId,
	);
	const conversationId = agent ? managedConversationId(agent) : undefined;

	const persistLocalRehostParameters = useCallback(
		(next: LocalHmuxPaneParameters) => {
			paneParamsRef.current = next as Params;
			api.updateParameters(next);
			return Boolean(commitWorkspaceLayout?.());
		},
		[api, commitWorkspaceLayout, paneParamsRef],
	);

	const executeRehost = useCallback(
		async (
			action: "rehost" | "refresh" = "rehost",
			diagnostics?: ManagedCreateDiagnostics,
		) => {
			if (paneActionPending(api.id, "rehost"))
				throw new Error("Hmux pane rehost action is already running");
			// Both entry points replace the Host and share one pane progress owner.
			const finishProgress = beginPaneActionProgress(api.id, "rehost");
			try {
				if (action === "refresh") {
					if (!refreshAvailable || !agent || !conversationId) {
						throw new Error(
							"managed exact resume launch target is unavailable",
						);
					}
					await resumeExactManagedAgentPane(
						agent.id,
						api.id,
						conversationId,
						diagnostics,
					);
					return;
				}
				if (localPaneRehost && hmuxBinding) {
					await executeLocalHmuxPaneRehost({
						panelId: api.id,
						component: api.component,
						binding: hmuxBinding,
						readParameters: () => paneParamsRef.current,
						persistParameters: persistLocalRehostParameters,
					});
					return;
				}
				if (!buildRehostSource) {
					throw new Error("Hmux pane rehost action is unavailable");
				}
				await rehostManagedBuild(buildRehostSource, api.id);
			} finally {
				finishProgress();
			}
		},
		[
			agent,
			api.id,
			api.component,
			buildRehostSource,
			conversationId,
			hmuxBinding,
			localPaneRehost,
			persistLocalRehostParameters,
			refreshAvailable,
		],
	);

	const runFromUi = useCallback(
		async (action: "rehost" | "refresh") => {
			try {
				await executeRehost(action);
				showToast(
					t(
						action === "refresh"
							? "workspace.refresh.success"
							: "workspace.rehost.success",
					),
					{ paneId: api.id },
				);
			} catch (error) {
				// Refresh already has an exact conversation target. A failed launch
				// does not invalidate that choice or request another history picker.
				if (
					action === "rehost" &&
					!(error instanceof ProviderConversationInputAuthorityError) &&
					agent &&
					hmuxBinding?.runtime === "hmux_managed_v1" &&
					hmuxBinding.source === "local"
				) {
					requestManagedRecovery(api.id);
				}
				showErrorToast(
					t(
						action === "refresh"
							? "workspace.refresh.failed"
							: "workspace.rehost.failed",
						{ error: String(error) },
					),
					{ paneId: api.id },
				);
			}
		},
		[agent, api.id, executeRehost, hmuxBinding],
	);

	const rehostAvailable =
		Boolean(localPaneRehost) || Boolean(buildRehostSource);
	usePaneActions(
		agent
			? agentRuntimePaneActionOwnerKey(agent)
			: hmuxBinding ? JSON.stringify([
				terminalRuntimePresentationOwnerKey(hmuxBinding),
				hmuxPaneConversationId(hmuxBinding),
			]) : undefined,
		rehostAvailable && !rehostBusy ? {
			paneId: api.id,
			actions: {
				rehost: () => executeRehost(),
				...(refreshAvailable && conversationId
					? {
							refresh: definePaneAction(
								{
									description: "Resume the exact conversation on a new Host.",
									parameters: {
										brokerTiming: {
											type: "boolean",
											description:
												"Return bounded frontend timing and record runtime broker timing for this request (local Unix only).",
										},
									},
								},
								async (input) => {
									const timing =
										input.brokerTiming === true
											? createManagedRefreshTiming()
											: undefined;
									await executeRehost(
										"refresh",
										timing ? { brokerTiming: true, timing } : undefined,
									);
									timing?.mark("action.complete");
									return {
										outcome: "applied",
										...(timing ? { value: { timing: timing.snapshot() } } : {}),
									};
								},
							),
						}
					: {}),
			},
		} : undefined,
	);

	return {
		rehostAvailable,
		rehostBusy,
		rehostToCurrentBuild: () => void runFromUi("rehost"),
		refreshConversation: refreshAvailable
			? () => void runFromUi("refresh")
			: undefined,
		refreshDisabled: !conversationId,
	};
}
