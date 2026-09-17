import { AccountsDialog } from "@/components/agents/AccountsDialog";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import { AgentPanelToolbarFrame } from "@/components/panels/AgentPanelToolbarFrame";
import { AgentPanelWindowActions } from "@/components/panels/AgentPanelWindowActions";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import { evaluateAgentProviderMutation } from "@/lib/agents/agentProviderMutationPolicy";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import {
	type CredentialProfileRecovery,
	runCredentialSwitchWithFeedback,
} from "@/lib/agents/credentialSwitchRecovery";
import {
	managedCredentialSwitchFailureMessage,
	managedCredentialSwitchIdentityBlock,
} from "@/lib/agents/freshCredentialSwitch";
import {
	supportsAccounts,
	supportsStructuredChat,
} from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import { rehydrateDurableStore } from "@/lib/persistence/durableStoreRehydration";
import {
	isHmuxPaneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
	requestAgentSessionCredentialCommand,
	requestAgentSessionForkPresentation,
} from "@/lib/workspace/window/agentSessionWindowCommand";
import { useStore } from "@/store";
import type { Agent } from "@/types";

/** Actions that remain meaningful when an Agent terminal moves to its large window. */
export function AgentSessionWindowToolbar({
	agent,
	binding,
	sourceWindowLabel,
	sourcePaneOwnerId,
}: {
	agent: Agent;
	binding: TerminalPaneBindingV1;
	sourceWindowLabel: string;
	sourcePaneOwnerId?: string;
}) {
	const runtimeOwnerKey = agentRuntimePresentationOwnerKey(agent);
	const accounts = useStore((state) => state.accounts);
	const agentRuntimeState = useStore(
		(state) => state.sessionAgentRuntimeState[agent.sessionId],
	);
	const project = useStore((state) =>
		state.projects.find((candidate) => candidate.id === agent.projectId),
	);
	const [ownedAccountsOpen, setAccountsOpen] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const accountsOpen = ownedAccountsOpen ?? false;
	const [accountRecovery, setAccountRecovery] =
		useRuntimeOwnedValue<CredentialProfileRecovery>(runtimeOwnerKey);
	const [accountFailure, setAccountFailure] =
		useRuntimeOwnedValue<string>(runtimeOwnerKey);
	const [ownedAccountBusy, setAccountBusy] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const accountBusy = ownedAccountBusy ?? false;
	const mutation = evaluateAgentProviderMutation(binding, "credential");
	const identityBlock =
		binding.runtime === "hmux_managed_v1" &&
		!supportsStructuredChat(agent.provider)
			? managedCredentialSwitchIdentityBlock(agent, agentRuntimeState)
			: undefined;
	const accountPool = supportsAccounts(agent.provider)
		? accounts.filter((account) => account.provider === agent.provider)
		: [];
	const followsGlobal = false;
	const effectiveAccountId = agentCredentialReferenceId(agent) ?? null;
	const currentAccount = effectiveAccountId
		? accountPool.find((account) => account.id === effectiveAccountId)
		: undefined;
	const pending =
		binding.runtime === "hmux_managed_v1"
			? agent.pendingCredentialSwitch
			: undefined;
	const unavailableTitle = sourcePaneOwnerId
		? mutation.allowed
			? t("common.paneAccount")
			: t("common.standaloneProviderSwapBlocked")
		: t("workspace.agentWindow.accountSwitchPaneMissing");

	const reportFailure = (error: unknown) => {
		if (supportsStructuredChat(agent.provider)) {
			setAccountFailure(error instanceof Error ? error.message : String(error));
			return;
		}
		const currentAgent = useStore
			.getState()
			.agents.find((candidate) => candidate.id === agent.id);
		setAccountFailure(
			managedCredentialSwitchFailureMessage(currentAgent, error),
		);
	};

	const runSwitch = (accountId: string | null) => {
		if (!sourcePaneOwnerId) return;
		setAccountFailure(undefined);
		const targetAccount = accountId
			? accountPool.find((account) => account.id === accountId)
			: undefined;
		setAccountBusy(true);
		void runCredentialSwitchWithFeedback({
			execute: () =>
				requestAgentSessionCredentialCommand({
					action: "switch",
					agentId: agent.id,
					targetCredentialId: accountId,
					sourceWindowLabel,
					sourcePaneOwnerId,
				}),
			account: targetAccount,
			onRecovery: (recovery) => {
				setAccountRecovery(recovery);
				setAccountsOpen(true);
			},
			onFailure: reportFailure,
		}).finally(() => setAccountBusy(false));
	};

	const applyPending = () => {
		if (!sourcePaneOwnerId) return;
		setAccountFailure(undefined);
		const targetAccount = pending?.targetCredentialId
			? accountPool.find((account) => account.id === pending.targetCredentialId)
			: undefined;
		setAccountBusy(true);
		void runCredentialSwitchWithFeedback({
			execute: () =>
				requestAgentSessionCredentialCommand({
					action: "apply_pending",
					agentId: agent.id,
					sourceWindowLabel,
					sourcePaneOwnerId,
				}),
			account: targetAccount,
			onRecovery: (recovery) => {
				setAccountRecovery(recovery);
				setAccountsOpen(true);
			},
			onFailure: reportFailure,
		}).finally(() => setAccountBusy(false));
	};

	return (
		<>
			<AgentPanelToolbarFrame
				agent={agent}
				hmux={isHmuxPaneBinding(binding)}
				presentFork={async (forkedAgent) => {
					if (!sourcePaneOwnerId) {
						throw new Error(
							t("workspace.agentWindow.forkPresentationFailed"),
						);
					}
					await rehydrateDurableStore();
					await requestAgentSessionForkPresentation({
						agentId: agent.id,
						forkedAgentId: forkedAgent.id,
						sourceWindowLabel,
						sourcePaneOwnerId,
					});
				}}
			>
				{supportsAccounts(agent.provider) && (
					<AgentCredentialSwitcher
						agentId={agent.id}
						provider={agent.provider}
						accounts={accountPool}
						currentAccount={currentAccount}
						followsGlobal={followsGlobal}
						pending={pending}
						failure={accountFailure}
						accountBusy={accountBusy}
						disabled={
							accountBusy ||
							!sourcePaneOwnerId ||
							!mutation.allowed ||
							Boolean(identityBlock)
						}
						disabledTitle={
							identityBlock
								? (identityBlock.reason ??
									t("common.accountSwitchAfterFirstMessage"))
								: unavailableTitle
						}
						onSwitch={runSwitch}
						onApplyNow={applyPending}
						onCancel={() => {
							if (!sourcePaneOwnerId) return;
							setAccountFailure(undefined);
							setAccountBusy(true);
							void requestAgentSessionCredentialCommand({
								action: "cancel_pending",
								agentId: agent.id,
								sourceWindowLabel,
								sourcePaneOwnerId,
							})
								.catch(reportFailure)
								.finally(() => setAccountBusy(false));
						}}
						onRemoteLogin={() => {}}
						onCopyToHost={() => {}}
						onManageAccounts={() => {
							setAccountRecovery(undefined);
							setAccountsOpen(true);
						}}
					/>
				)}
				<AgentPanelWindowActions
					agent={agent}
					project={project}
					showDiff={project?.kind !== "ssh"}
				/>
			</AgentPanelToolbarFrame>
			{accountsOpen && (
				<AccountsDialog
					recovery={accountRecovery}
					onClose={() => {
						setAccountsOpen(false);
						setAccountRecovery(undefined);
					}}
				/>
			)}
		</>
	);
}
