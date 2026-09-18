import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import { SharedConversationAccountMenu } from "@/components/agents/chat/SharedConversationAccountMenu";
import { StructuredAgentChatSurface } from "@/components/agents/chat/StructuredAgentChatSurface";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { useSharedConversationAccountsState } from "@/components/agents/chat/useSharedConversationAccountsState";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import { switchSharedConversationAccount } from "@/lib/agents/chat/sharedConversationAccounts";
import { latestTurnFailure } from "@/lib/agents/chat/turnFailureReason";
import { PROVIDER_IDS } from "@/lib/agents/providerCatalog";
import { t } from "@/lib/i18n";
import { supportsDureProviderCredentialSpawn } from "@/lib/ipc/dureProviderCredentialProfile";

export function SharedAgentConversation({
	target,
	header,
}: {
	target: SharedAgentConversationTarget;
	header?: ReactNode;
}) {
	return (
		<SharedConversationContent
			key={JSON.stringify(target)}
			initialTarget={target}
			header={header}
		/>
	);
}

function SharedConversationContent({
	initialTarget,
	header,
}: {
	initialTarget: SharedAgentConversationTarget;
	header?: ReactNode;
}) {
	const [target, setTarget] = useState(initialTarget);
	const session: AgentChatSessionView = useAgentChatSession(
		target.agentId,
		target.profile,
		undefined,
		target.authority,
	);
	const accounts = useSharedConversationAccountsState();
	const [accountMenu, setAccountMenu] = useState(false);
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
			setAccountMenu(false);
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
			{(header || supported) && (
				<div className="flex shrink-0 items-center gap-2 px-3 py-2">
					{header}
					{supported && (
						<div className="ml-auto shrink-0">
							<SharedConversationAccountMenu
								target={target}
								provider={provider}
								selectedId={accountId}
								currentName={currentName}
								busy={busy}
								disabled={locked}
								open={accountMenu}
								onOpenChange={setAccountMenu}
								onSelect={(id, name) => void selectAccount(id, name)}
							/>
						</div>
					)}
				</div>
			)}
			{error && <ChatAlert className="mx-2 mb-2">{error}</ChatAlert>}
			<div className="min-h-0 flex-1">
				<StructuredAgentChatSurface
					session={session}
					attachmentsEnabled={false}
					disabled={busy}
					recovery={
						supported
							? {
									manageAccounts: () => setAccountMenu(true),
									chooseAccount: () => setAccountMenu(true),
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
		</div>
	);
}
