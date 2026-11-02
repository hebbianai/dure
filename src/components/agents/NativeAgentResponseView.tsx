import { MessageSquareText, SquareTerminal } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { NativeAgentChatView } from "@/components/agents/NativeAgentChatView";
import { useNativeAgentResponseState } from "@/components/agents/useAgentDisplayState";
import { useNativeAgentChatState } from "@/components/agents/useNativeAgentChatState";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { nativeAgentChatIdle } from "@/lib/agents/chat/nativeAgentChat";
import { nativeFinalResponse } from "@/lib/agents/nativeFinalResponse";
import { t } from "@/lib/i18n";
import { readProviderConversationTranscript } from "@/lib/ipc/conversations";
import type { Agent } from "@/types";
import { nativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

type NativeAgentView = "terminal" | "conversation";

/** Both docked and detached panes keep the same native terminal mounted and
 * sized. Only its presentation is covered; input/recovery never changes owners.
 * Pro panes can also be flipped to the conversation view; that selection is
 * pane-local presentation state and never switches the runtime. */
export function NativeAgentResponseView({
	agent,
	disabled = false,
	children,
}: {
	agent: Agent;
	disabled?: boolean;
	children: ReactNode;
}) {
	const mode = useInterfaceMode();
	const { enabled, runtime, state } = useNativeAgentResponseState(agent);
	const source = nativeAgentTranscriptSource(agent, agent.runtimeBinding);
	const provider = source.kind === "local" ? source.provider : undefined;
	const conversationId =
		source.kind === "local" ? source.conversationId : undefined;
	const binding = agent.runtimeBinding;
	const conversationEpoch =
		binding?.runtime === "hmux_managed_v1"
			? binding.conversationIdentity?.terminalEpoch
			: undefined;
	const count = runtime?.turnCompletedCount;
	const ownerKey = JSON.stringify([
		agentRuntimePresentationOwnerKey(agent),
		conversationId,
		runtime?.terminalEpoch,
		count,
		state,
	]);
	const [response, setResponse] = useRuntimeOwnedValue<string | null>(ownerKey);
	const [revealed, setRevealed] = useRuntimeOwnedValue<string>(ownerKey);
	const [view, setView] = useState<NativeAgentView>("terminal");
	// The conversation's runtime state is owned here, keyed to the Agent's
	// recorded conversation rather than the live runtime projection, so a
	// momentary drop of the projection does not forget a sent prompt.
	const chat = useNativeAgentChatState(
		JSON.stringify([
			agentRuntimePresentationOwnerKey(agent),
			conversationId,
			conversationEpoch,
		]),
		nativeAgentChatIdle({ runtime, state }),
	);
	// The toggle's row is reserved whenever this pane can offer the
	// conversation at all (from launch, before the first conversation is
	// observed), so it never covers terminal cells and neither a transient
	// runtime drop nor a new conversation resizes the terminal.
	const conversationOffered = Boolean(
		mode === "pro" &&
			(source.kind === "local" || source.kind === "identity_unavailable") &&
			binding?.runtime === "hmux_managed_v1",
	);
	const conversationAvailable = Boolean(
		conversationOffered &&
			source.kind === "local" &&
			!disabled &&
			runtime?.lifecycle === "running" &&
			conversationEpoch === runtime.terminalEpoch,
	);
	const conversation =
		conversationAvailable &&
		view === "conversation" &&
		source.kind === "local" &&
		runtime
			? { source, runtime }
			: undefined;
	const eligible =
		conversationAvailable &&
		enabled &&
		runtime?.attention === "none" &&
		(state === "working" || state === "waiting");
	const completed = count !== undefined && /^[1-9]\d*$/.test(count);
	const shouldRead = Boolean(
		!conversation && eligible && completed && state === "waiting",
	);

	useEffect(() => {
		if (!shouldRead || !provider || !conversationId) return;
		let current = true;
		void readProviderConversationTranscript(provider, conversationId)
			.then((transcript) =>
				nativeFinalResponse(
					{
						kind: "local",
						agentId: agent.id,
						provider,
						conversationId,
					},
					transcript,
				),
			)
			.then((text) => {
				if (current) setResponse(text);
			})
			.catch(() => {
				if (current) setResponse(null);
			});
		return () => {
			current = false;
		};
	}, [shouldRead, provider, conversationId, agent.id, setResponse]);

	// Revealing the native prompt lasts until the next work/completion state.
	// There is no terminal text parsing, keyboard interception, or runtime switch.
	const responseCovered = Boolean(
		!conversation &&
			eligible &&
			revealed !== state &&
			(state === "working" || (completed && response !== null)),
	);
	// An explicit request for the terminal shows the terminal itself, not the
	// final-response overlay that would otherwise cover it.
	const showView = (next: NativeAgentView) => {
		setView(next);
		if (next === "terminal") setRevealed(state);
	};
	const covered = responseCovered || conversation !== undefined;
	return (
		<div className="flex h-full min-h-0 flex-col">
			{conversationOffered && (
				<div className="flex h-8 shrink-0 items-center justify-end bg-surface-terminal px-2">
					{conversationAvailable && (
						<Segmented
							variant="pills"
							size="sm"
							iconOnly
							aria-label={t("agents.runtime.viewLabel")}
							value={conversation ? "conversation" : "terminal"}
							onChange={showView}
							options={[
								{
									value: "terminal",
									label: t("common.terminal"),
									icon: (
										<SquareTerminal aria-hidden="true" className="size-3.5" />
									),
								},
								{
									value: "conversation",
									label: t("agents.nativeChat.conversation"),
									icon: (
										<MessageSquareText
											aria-hidden="true"
											className="size-3.5"
										/>
									),
								},
							]}
						/>
					)}
				</div>
			)}
			<div className="relative min-h-0 flex-1">
				<div
					className="h-full"
					inert={covered}
					aria-hidden={covered || undefined}
					style={covered ? { visibility: "hidden" } : undefined}
				>
					{children}
				</div>
				{conversation && (
					<NativeAgentChatView
						agent={agent}
						source={conversation.source}
						runtime={conversation.runtime}
						state={state}
						chat={chat}
						onContinueInTerminal={() => showView("terminal")}
					/>
				)}
				{responseCovered && (
					<section
						className="absolute inset-0 flex min-h-0 flex-col bg-surface-terminal p-4"
						aria-label={t("settings.terminal.finalResponseOnly.title")}
					>
						<div
							role="region"
							aria-label={t("settings.terminal.finalResponseOnly.title")}
							className="min-h-0 flex-1 overflow-auto text-sm leading-relaxed"
						>
							{state === "working" ? (
								<p role="status" className="text-muted-foreground">
									{t("common.working")}
								</p>
							) : response === undefined ? (
								<p role="status" className="text-muted-foreground">
									{t("common.loading")}
								</p>
							) : (
								<ChatMarkdown markdown={response ?? ""} />
							)}
						</div>
						<Button
							variant="outline"
							size="sm"
							className="mt-3 self-start"
							onClick={() => setRevealed(state)}
						>
							{t("agents.finalResponse.continueInTerminal")}
						</Button>
					</section>
				)}
			</div>
		</div>
	);
}
