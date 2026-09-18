import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import { SharedConversationAccountDialog } from "@/components/agents/chat/SharedConversationAccountDialog";
import { StructuredAgentChatSurface } from "@/components/agents/chat/StructuredAgentChatSurface";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { Button } from "@/components/ui/button";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import { switchSharedConversationAccount } from "@/lib/agents/chat/sharedConversationAccounts";
import { latestTurnFailure } from "@/lib/agents/chat/turnFailureReason";
import { PROVIDER_IDS } from "@/lib/agents/providerCatalog";
import { supportsDureProviderCredentialSpawn } from "@/lib/ipc/dureProviderCredentialProfile";
import { t } from "@/lib/i18n";
import { useSharedConversationAccountsState } from "@/components/agents/chat/useSharedConversationAccountsState";

export function SharedAgentConversation({
	target,
}: {
	target: SharedAgentConversationTarget;
}) {
	return (
		<SharedConversationContent
			key={JSON.stringify(target)}
			initialTarget={target}
		/>
	);
}

function SharedConversationContent({
	initialTarget,
}: {
	initialTarget: SharedAgentConversationTarget;
}) {
	const [target, setTarget] = useState(initialTarget);
	const session: AgentChatSessionView = useAgentChatSession(
		target.agentId,
		target.profile,
		undefined,
		target.authority,
	);
	const accounts = useSharedConversationAccountsState();
	const [accountDialog, setAccountDialog] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [switched, setSwitched] = useState<{
		failureId?: string;
		accountId: string | null;
		name: string;
	}>();
	const changing = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const binding = session.page?.binding;
	const provider = binding
		? PROVIDER_IDS.find((provider) => provider === binding.providerId)
		: null;
	const supported = provider && supportsDureProviderCredentialSpawn(provider);
	const accountId =
		binding?.executionProfile.kind === "credential_reference"
			? binding.executionProfile.reference_id
			: null;
	const currentName =
		switched?.accountId === accountId
			? switched.name
			: accountId
				? ((target.authority.target.source === "local"
						? accounts.find(
								(account) =>
									account.id === accountId && account.provider === provider,
							)?.name
						: undefined) ?? accountId)
				: t("agents.account.defaultCli");
	const locked =
		busy ||
		session.phase !== "ready" ||
		session.reconnecting ||
		Boolean(session.activeTurn) ||
		session.sending ||
		session.interrupting ||
		session.answeringRequestId !== undefined;
	const failure = session.activeTurn
		? undefined
		: latestTurnFailure(session.page?.latestFailure);
	const handled =
		switched?.failureId === failure?.itemId &&
		switched?.failureId !== undefined;

	async function selectAccount(id: string | null, name: string) {
		if (!binding || locked || changing.current) return;
		changing.current = true;
		setBusy(true);
		setError(undefined);
		try {
			const result = await switchSharedConversationAccount(
				target,
				binding,
				id,
				accounts,
			);
			if (!mounted.current) return;
			setTarget({
				...target,
				profile: {
					...target.profile,
					interactionSessionId: result.interactionSessionId,
				},
			});
			setSwitched({ failureId: failure?.itemId, accountId: id, name });
			setAccountDialog(false);
			session.retryConnection();
		} catch (reason) {
			if (mounted.current)
				setError(
					reason instanceof Error
						? reason.message
						: t("agents.runtime.switchFailed"),
				);
		} finally {
			changing.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	return (
		<div className="flex h-full min-h-0 flex-col">
			{supported && (
				<div className="flex shrink-0 justify-end px-2 pb-1">
					<Button
						size="xs"
						variant="ghost"
						title={t("agents.chat.recovery.chooseAccount")}
						onClick={() => setAccountDialog(true)}
						disabled={busy}
					>
						<KeyRound />
						<span className="max-w-40 truncate">
							{busy ? t("agents.account.switchInProgress") : currentName}
						</span>
					</Button>
				</div>
			)}
			{error && !accountDialog && (
				<ChatAlert className="mx-2 mb-2">{error}</ChatAlert>
			)}
			<div className="min-h-0 flex-1">
				<StructuredAgentChatSurface
					session={session}
					attachmentsEnabled={false}
					disabled={busy}
					recovery={
						supported
							? {
									manageAccounts: () => setAccountDialog(true),
									chooseAccount: () => setAccountDialog(true),
									...(handled && switched
										? {
												handedOff: {
													toName: switched.name,
													...(!locked &&
													failure?.userInput !== undefined &&
													!session.retryTurnAvailable
														? { resend: () => session.send(failure.userInput!) }
														: {}),
												},
											}
										: {}),
								}
							: undefined
					}
				/>
			</div>
			{accountDialog && provider && (
				<SharedConversationAccountDialog
					target={target}
					provider={provider}
					selectedId={accountId}
					busy={busy}
					disabled={locked}
					error={error}
					onSelect={(id, name) => void selectAccount(id, name)}
					onClose={() => setAccountDialog(false)}
				/>
			)}
		</div>
	);
}
