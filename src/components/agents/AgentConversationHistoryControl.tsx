import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AgentConversationMenu,
	type AgentConversationTarget,
} from "@/components/agents/AgentConversationControls";
import { managedLiveConversationHistoryAvailable } from "@/lib/agents/agentConversationHistory";
import { t } from "@/lib/i18n";
import type { Conversation } from "@/lib/ipc";
import {
	launchManagedConversationTargetInSibling,
	managedConversationLaunchFailureMessage,
} from "@/lib/sessions/managed/managedConversationLaunch";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { subscribeConversationHistoryMenu } from "@/lib/workspace/pane/paneMenuSignals";
import { useStore } from "@/store";
import type { Agent, AgentActivity, Project } from "@/types";

export interface AgentConversationHistoryActionLease {
	readonly busy: boolean;
	run(action: () => Promise<void>): Promise<boolean>;
}

/** One history mutation lease owned by the Agent pane, above runtime-keyed
 * Native/Structured children. A child remount can project this lease but
 * cannot create a second launch authority. */
export function useAgentConversationHistoryActionLease(): AgentConversationHistoryActionLease {
	const actionInFlightRef = useRef(false);
	const [, setBusy] = useState(false);
	const run = useCallback(async (action: () => Promise<void>) => {
		if (actionInFlightRef.current) return false;
		actionInFlightRef.current = true;
		setBusy(true);
		try {
			await action();
			return true;
		} finally {
			actionInFlightRef.current = false;
			setBusy(false);
		}
	}, []);
	return useMemo(
		() => ({
			get busy() {
				return actionInFlightRef.current;
			},
			run,
		}),
		[run],
	);
}

export function AgentConversationHistoryControl({
	actionLease,
	activeConversationId,
	activity,
	agent,
	binding,
	conversations,
	mutationAllowed,
	mutationDisabledTitle,
	onError,
	onLoad,
	onSwitchExisting,
	paneDesktopId,
	panelId,
	projectKind,
	resuming,
}: {
	actionLease: AgentConversationHistoryActionLease;
	activeConversationId: string | null;
	activity: AgentActivity;
	agent: Agent;
	binding: TerminalPaneBindingV1 | undefined;
	conversations: Conversation[] | null;
	mutationAllowed: boolean;
	mutationDisabledTitle: string;
	onError(error: unknown): void;
	onLoad(): void;
	onSwitchExisting(target: AgentConversationTarget): Promise<void>;
	paneDesktopId: string | undefined;
	/** pane 톱바 ⋮의 "최근 작업" 항목이 이 메뉴를 신호로 연다. */
	panelId: string;
	projectKind: Project["kind"] | undefined;
	resuming: boolean;
}) {
	const [open, setOpen] = useState(false);
	// controlled open은 Radix onOpenChange를 타지 않으므로 목록 로드도 신호
	// 핸들러가 직접 부른다. onLoad는 렌더마다 정체성이 바뀌어 ref로 고정.
	const onLoadRef = useRef(onLoad);
	onLoadRef.current = onLoad;
	useEffect(
		() =>
			subscribeConversationHistoryMenu(panelId, () => {
				setOpen(true);
				onLoadRef.current();
			}),
		[panelId],
	);
	const managedLive = managedLiveConversationHistoryAvailable({
		activity,
		binding,
		interactionProfile: agent.interactionProfile,
		projectKind,
		provider: agent.provider,
	});
	if (!managedLive && activity !== "exited") return null;
	const exactResumeAvailable =
		activity === "exited" &&
		binding?.runtime === "hmux_managed_v1" &&
		binding.source === "local";

	const switchConversation = async (target: AgentConversationTarget) => {
		await actionLease.run(async () => {
			if (!mutationAllowed && (target.kind !== "id" || !exactResumeAvailable)) {
				throw new Error(mutationDisabledTitle);
			}
			if (!managedLive) {
				await onSwitchExisting(target);
			} else {
				await launchManagedConversationTargetInSibling({
					sourceAgentId: agent.id,
					desktopId: paneDesktopId ?? useStore.getState().activeSpaceId,
					referencePanelId: panelId,
					target,
				});
			}
		});
	};
	const reportError = (error: unknown) =>
		onError(managedLive ? managedConversationLaunchFailureMessage(error) : error);

	return (
		<AgentConversationMenu
			activeConversationId={activeConversationId}
			conversations={conversations}
			disabled={
				resuming ||
				actionLease.busy ||
				(!mutationAllowed && !exactResumeAvailable)
			}
			disabledTitle={mutationDisabledTitle}
			freshDisabled={!mutationAllowed}
			freshLabel={
				managedLive
					? t("agents.conversation.newInNewPane")
					: t("common.newConversation")
			}
			hiddenTrigger
			onError={reportError}
			onLoad={onLoad}
			onOpenChange={setOpen}
			onSwitch={switchConversation}
			open={open}
			resumeLabel={
				managedLive
					? t("common.continueInNewPane")
					: t("agents.conversation.resume")
			}
			triggerTitle={
				managedLive
					? t("agents.conversation.recentWorkNewPane")
					: t("agents.conversation.recoverExited")
			}
		/>
	);
}
