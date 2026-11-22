import type { ComponentProps, ReactNode } from "react";
import { AccountsDialog } from "@/components/agents/AccountsDialog";
import type { AgentForkPresenter } from "@/components/agents/AgentContextMenu";
import { AgentConversationHistoryControl } from "@/components/agents/AgentConversationHistoryControl";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { AgentProjectMove } from "@/components/agents/AgentProjectMove";
import { AgentViewControl } from "@/components/agents/AgentViewControl";
import {
	AgentToolbarSurfaceProvider,
	useAgentLaunchControlsPresentation,
	useAgentToolbarControls,
	useAgentToolbarGroupPresentation,
} from "@/components/agents/useAgentToolbarControls";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import { AgentPanelToolbarFrame } from "@/components/panels/AgentPanelToolbarFrame";
import { AgentPanelWindowActions } from "@/components/panels/AgentPanelWindowActions";
import { useNativeAgentToolbarState } from "@/components/panels/useAgentPanelState";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import type { AgentProjectMovePort } from "@/lib/agents/agentProjectMoveTypes";
import { evaluateAgentProviderMutation } from "@/lib/agents/agentProviderMutationPolicy";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { NativeAgentViewPort } from "@/lib/agents/chatHandover";
import {
	type CredentialProfileRecovery,
	runCredentialSwitchWithFeedback,
} from "@/lib/agents/credentialSwitchRecovery";
import {
	managedCredentialSwitchFailureMessage,
	managedCredentialSwitchIdentityBlock,
} from "@/lib/agents/freshCredentialSwitch";
import { nativeConversationViewAvailability } from "@/lib/agents/nativeConversationView";
import { agentProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import {
	supportsAccounts,
	supportsStructuredChat,
} from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import {
	isHmuxPaneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { AgentToolbarSurface } from "@/lib/workspace/pane/agentToolbarControls";
import type { AccountProfile, Agent } from "@/types";

const WINDOW_ACTION_CONTROL_IDS = [
	"diff-window",
	"source-control-window",
] as const;

/** Where this surface runs an Agent's credential moves. */
interface NativeAgentToolbarAccountRuntime {
	switch(accountId: string | null): Promise<unknown>;
	applyPending(): Promise<unknown>;
	cancelPending(): Promise<unknown>;
	/** The pane also opens the account menu from its sign-in recovery. */
	readonly menu?: { open: boolean; onOpenChange(open: boolean): void };
	/** SSH host sign-in and copy open a terminal in the pane's own dock. */
	readonly remote?: {
		readonly hostName?: string;
		readonly busy: boolean;
		openLogin(account: AccountProfile): void;
		copyToHost(account: AccountProfile): void;
	};
}

/** What differs between the surfaces that render one Agent's toolbar: where
 * its actions execute and the pane-owned state they report. Which controls
 * render, in which order and under which capability and policy checks is
 * decided once, below, for every surface. */
export interface NativeAgentToolbarRuntime {
	readonly surface: AgentToolbarSurface;
	/** Set when the window that owns this Agent's runtime cannot be reached;
	 * every control that runs there is disabled with this title. */
	readonly sourceUnavailableTitle?: string;
	/** A runtime transition this surface started (or the pane owns) is running. */
	readonly transitioning: boolean;
	setTransitioning(busy: boolean): void;
	/** The response view's own lock (attach or stale-input recovery). */
	readonly conversationViewDisabled: boolean;
	readonly presentFork: AgentForkPresenter;
	readonly account: NativeAgentToolbarAccountRuntime;
	readonly view: NativeAgentViewPort;
	readonly projectMove: AgentProjectMovePort;
	/** Pane-only until AGENT_TOOLBAR_CONTROLS offers them on the large window. */
	readonly launchSelection?: AgentRuntimeLaunchSelectionView;
	readonly history?: Omit<
		ComponentProps<typeof AgentConversationHistoryControl>,
		"agent" | "binding"
	>;
	/** Pane presence indicators that are not toolbar controls. */
	readonly paneStatus?: ReactNode;
}

/** The one toolbar of a native-terminal Agent, rendered by its pane and by
 * its large window (#624). */
export function NativeAgentToolbar(props: {
	agent: Agent;
	binding: TerminalPaneBindingV1;
	runtime: NativeAgentToolbarRuntime;
}) {
	return (
		<AgentToolbarSurfaceProvider value={props.runtime.surface}>
			<NativeAgentToolbarControls {...props} />
		</AgentToolbarSurfaceProvider>
	);
}

function NativeAgentToolbarControls({
	agent,
	binding,
	runtime,
}: {
	agent: Agent;
	binding: TerminalPaneBindingV1;
	runtime: NativeAgentToolbarRuntime;
}) {
	const runtimeOwnerKey = agentRuntimePresentationOwnerKey(agent);
	const { accounts, project, agentRuntimeState, getAgentById } =
		useNativeAgentToolbarState(agent);
	const toolbarControls = useAgentToolbarControls();
	const launchControlsPresentation = useAgentLaunchControlsPresentation(
		runtime.launchSelection,
	);
	const windowActionsPresentation = useAgentToolbarGroupPresentation(
		WINDOW_ACTION_CONTROL_IDS,
	);
	const [ownedAccountsOpen, setAccountsOpen] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const accountsOpen = ownedAccountsOpen ?? false;
	const [accountRecovery, setAccountRecovery] =
		useRuntimeOwnedValue<CredentialProfileRecovery>(runtimeOwnerKey);
	const [accountFailure, setAccountFailure] =
		useRuntimeOwnedValue<string>(runtimeOwnerKey);
	const [remoteRecoveryAccount, setRemoteRecoveryAccount] =
		useRuntimeOwnedValue<AccountProfile>(runtimeOwnerKey);

	const { transitioning, setTransitioning, sourceUnavailableTitle } = runtime;
	const sourceUnavailable = sourceUnavailableTitle !== undefined;
	const backendManaged = binding.runtime === "hmux_managed_v1";
	const structuredRuntimeActionsAvailable =
		backendManaged && supportsStructuredChat(agent.provider);
	const credentialMutation = evaluateAgentProviderMutation(
		binding,
		"credential",
	);
	const standaloneMutationMessage = t("common.standaloneProviderSwapBlocked");

	// --- Account ---
	const accountPool = supportsAccounts(agent.provider)
		? accounts.filter((account) => account.provider === agent.provider)
		: [];
	const effectiveAccountId = agentCredentialReferenceId(agent) ?? null;
	const currentAccount = effectiveAccountId
		? accountPool.find((account) => account.id === effectiveAccountId)
		: undefined;
	// A launch-selection-only intent keeps its credential; the launch pills
	// present it, not the account switcher.
	const pendingCredentialSwitch =
		backendManaged &&
		(!agent.pendingCredentialSwitch?.targetLaunchSelection ||
			agent.pendingCredentialSwitch.targetCredentialId !==
				agent.pendingCredentialSwitch.sourceCredentialId)
			? agent.pendingCredentialSwitch
			: undefined;
	const identityBlock =
		backendManaged && !structuredRuntimeActionsAvailable
			? managedCredentialSwitchIdentityBlock(agent, agentRuntimeState)
			: undefined;
	const openAccountRecovery = (recovery: CredentialProfileRecovery) => {
		setAccountFailure(undefined);
		setAccountRecovery(recovery);
		setAccountsOpen(true);
	};
	// Say why it was blocked: waiting for the first message and a conflict the
	// user must resolve are different states.
	const reportAccountFailure = (error: unknown) => {
		if (structuredRuntimeActionsAvailable) {
			setAccountFailure(error instanceof Error ? error.message : String(error));
			return;
		}
		setAccountFailure(
			managedCredentialSwitchFailureMessage(getAgentById(agent.id), error),
		);
	};
	const whileTransitioning = async (action: () => Promise<unknown>) => {
		setTransitioning(true);
		try {
			await action();
		} finally {
			setTransitioning(false);
		}
	};
	const runAccountSwitch = (accountId: string | null) => {
		setAccountFailure(undefined);
		setRemoteRecoveryAccount(undefined);
		const targetAccount = accountId
			? accountPool.find((account) => account.id === accountId)
			: undefined;
		void runCredentialSwitchWithFeedback({
			execute: async () => {
				// Only a managed Host can replace the running provider process.
				if (!credentialMutation.allowed || !backendManaged) {
					throw new Error(standaloneMutationMessage);
				}
				if (accountId && !targetAccount) {
					throw new Error("credential_reference_unavailable");
				}
				await whileTransitioning(() => runtime.account.switch(accountId));
			},
			account: targetAccount,
			onRecovery: (recovery) => {
				setRemoteRecoveryAccount(targetAccount);
				openAccountRecovery(recovery);
			},
			onFailure: (error) => {
				setRemoteRecoveryAccount(targetAccount);
				reportAccountFailure(error);
			},
		}).then((outcome) => {
			if (outcome === "completed") setRemoteRecoveryAccount(undefined);
		});
	};
	const applyPendingAccountSwitch = () => {
		setAccountFailure(undefined);
		const targetAccount = pendingCredentialSwitch?.targetCredentialId
			? accountPool.find(
					(account) =>
						account.id === pendingCredentialSwitch.targetCredentialId,
				)
			: undefined;
		void runCredentialSwitchWithFeedback({
			execute: () => whileTransitioning(() => runtime.account.applyPending()),
			account: targetAccount,
			onRecovery: openAccountRecovery,
			onFailure: reportAccountFailure,
		});
	};
	const cancelPendingAccountSwitch = () => {
		setAccountFailure(undefined);
		void runtime.account.cancelPending().catch(reportAccountFailure);
	};
	const accountMenuOpen = runtime.account.menu?.open ?? false;

	// --- View ---
	const conversationView = nativeConversationViewAvailability(
		agent,
		agentRuntimeState,
		transitioning || runtime.conversationViewDisabled,
	);
	const presentedView =
		conversationView.available && agent.nativeView === "conversation"
			? "conversation"
			: "terminal";

	return (
		<>
			<AgentPanelToolbarFrame
				agent={agent}
				hmux={isHmuxPaneBinding(binding)}
				presentFork={runtime.presentFork}
			>
				{runtime.paneStatus}
				{/* The pane's own account: only this Agent changes, and its
				    conversation resumes on the new account. */}
				{supportsAccounts(agent.provider) &&
					toolbarControls.visible("account", {
						mustShow:
							!!pendingCredentialSwitch || !!accountFailure || accountMenuOpen,
					}) &&
					toolbarControls.slot(
						"account",
						<AgentCredentialSwitcher
							agentId={agent.id}
							provider={agent.provider}
							open={runtime.account.menu?.open}
							onOpenChange={runtime.account.menu?.onOpenChange}
							accounts={accountPool}
							currentAccount={currentAccount}
							recoveryAccount={remoteRecoveryAccount}
							followsGlobal={false}
							pending={pendingCredentialSwitch}
							failure={accountFailure}
							hostName={runtime.account.remote?.hostName}
							accountBusy={runtime.account.remote?.busy ?? false}
							disabled={
								transitioning ||
								sourceUnavailable ||
								!credentialMutation.allowed ||
								!!identityBlock
							}
							disabledTitle={
								sourceUnavailableTitle ??
								(identityBlock
									? (identityBlock.reason ??
										t("common.accountSwitchAfterFirstMessage"))
									: credentialMutation.allowed
										? t("common.paneAccount")
										: standaloneMutationMessage)
							}
							onSwitch={runAccountSwitch}
							onApplyNow={applyPendingAccountSwitch}
							onCancel={cancelPendingAccountSwitch}
							onRemoteLogin={(account) =>
								runtime.account.remote?.openLogin(account)
							}
							onCopyToHost={(account) =>
								runtime.account.remote?.copyToHost(account)
							}
							onManageAccounts={() => {
								setAccountRecovery(undefined);
								setAccountsOpen(true);
							}}
						/>,
					)}
				{backendManaged && runtime.launchSelection && (
					<AgentLaunchSelectionControls
						provider={agent.provider}
						launch={runtime.launchSelection}
						catalogSource={agentProviderCatalogSource(agent, project, accounts)}
						busy={transitioning || !!agent.pendingCredentialSwitch}
						presentation={launchControlsPresentation}
					/>
				)}
				{(structuredRuntimeActionsAvailable || conversationView.offered) &&
					toolbarControls.visible("view-switch", {
						mustShow: !!agent.pendingChatHandover,
					}) &&
					toolbarControls.slot(
						"view-switch",
						<AgentViewControl
							key={`runtime-profile:${runtimeOwnerKey}`}
							agentId={agent.id}
							view={presentedView}
							pending={agent.pendingChatHandover}
							conversationOffered={conversationView.offered}
							conversationAvailable={conversationView.available}
							chatAvailable={structuredRuntimeActionsAvailable}
							disabled={transitioning || sourceUnavailable}
							disabledTitle={
								sourceUnavailableTitle ??
								(transitioning ? t("common.loading") : undefined)
							}
							chatDisabledTitle={
								agent.pendingCredentialSwitch
									? t("agents.runtime.finishCredentialSwitchFirst")
									: undefined
							}
							port={runtime.view}
							onSwitchingChange={setTransitioning}
						/>,
					)}
				{structuredRuntimeActionsAvailable &&
					toolbarControls.visible("project-move") &&
					toolbarControls.slot(
						"project-move",
						<AgentProjectMove
							key={`project-move:${runtimeOwnerKey}`}
							port={runtime.projectMove}
							disabled={
								transitioning ||
								sourceUnavailable ||
								!!agent.pendingCredentialSwitch ||
								!!agent.pendingCmd
							}
							disabledTitle={sourceUnavailableTitle}
							onBusyChange={setTransitioning}
						/>,
					)}
				<AgentPanelWindowActions
					agent={agent}
					project={project}
					showDiff={project?.kind !== "ssh"}
					presentation={windowActionsPresentation}
				/>
				{runtime.history &&
					toolbarControls.visible("conversation-history") &&
					toolbarControls.slot(
						"conversation-history",
						<AgentConversationHistoryControl
							key={`conversation-history:${runtimeOwnerKey}`}
							{...runtime.history}
							agent={agent}
							binding={binding}
						/>,
					)}
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
