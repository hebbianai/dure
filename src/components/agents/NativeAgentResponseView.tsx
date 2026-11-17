import { type ReactNode, useEffect, useRef } from "react";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { NativeAgentChatView } from "@/components/agents/NativeAgentChatView";
import { useNativeAgentResponseState } from "@/components/agents/useAgentDisplayState";
import { useNativeAgentChatState } from "@/components/agents/useNativeAgentChatState";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import { Button } from "@/components/ui/button";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { nativeAgentChatIdle } from "@/lib/agents/chat/nativeAgentChat";
import { setNativeAgentView } from "@/lib/agents/chatHandoverRuntime";
import { nativeConversationViewAvailability } from "@/lib/agents/nativeConversationView";
import { nativeFinalResponse } from "@/lib/agents/nativeFinalResponse";
import { t } from "@/lib/i18n";
import { readProviderConversationTranscript } from "@/lib/ipc/conversations";
import { useStore } from "@/store";
import type { Agent } from "@/types";
import { nativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

/** Both docked and detached panes keep the same native terminal mounted and
 * sized. Only its presentation is covered; input/recovery never changes owners.
 * The pane's View menu flips it to the Conversation; that choice is
 * remembered per Agent and never switches the runtime. */
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
	const view =
		useStore(
			(s) =>
				s.agents.find((candidate) => candidate.id === agent.id)?.nativeView,
		) ??
		agent.nativeView ??
		"terminal";
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
	const conversationAvailable = nativeConversationViewAvailability(
		agent,
		runtime,
		disabled,
	).available;
	const conversation =
		conversationAvailable &&
		view === "conversation" &&
		source.kind === "local" &&
		runtime
			? { source, runtime }
			: undefined;
	// The final-response presentation stays a Pro setting; the Conversation
	// view itself is offered in Basic and Pro alike.
	const eligible =
		conversationAvailable &&
		mode === "pro" &&
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
	const previousView = useRef(view);
	useEffect(() => {
		if (previousView.current === "conversation" && view === "terminal") {
			setRevealed(state);
		}
		previousView.current = view;
	}, [view, state, setRevealed]);
	const covered = responseCovered || conversation !== undefined;
	return (
		<div className="flex h-full min-h-0 flex-col">
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
						onContinueInTerminal={() =>
							setNativeAgentView(agent.id, "terminal")
						}
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
