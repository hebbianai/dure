import { MessageSquareText, SquareTerminal } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { NativeAgentChatView } from "@/components/agents/NativeAgentChatView";
import { useNativeAgentResponseState } from "@/components/agents/useAgentDisplayState";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
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
	const [draft, setDraft] = useState("");
	const conversationAvailable = Boolean(
		mode === "pro" &&
			!disabled &&
			source.kind === "local" &&
			runtime?.lifecycle === "running" &&
			agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
			agent.runtimeBinding?.conversationIdentity?.terminalEpoch ===
				runtime.terminalEpoch,
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
	const covered = responseCovered || conversation !== undefined;
	return (
		<div className="relative h-full min-h-0">
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
					draft={draft}
					onDraftChange={setDraft}
					onContinueInTerminal={() => setView("terminal")}
				/>
			)}
			{conversationAvailable && (
				<div
					role="group"
					aria-label={t("agents.runtime.viewLabel")}
					className="absolute top-2 right-2 z-20"
				>
					<Segmented
						variant="pills"
						size="sm"
						iconOnly
						className="bg-glass-chrome shadow-card backdrop-blur-xl"
						value={conversation ? "conversation" : "terminal"}
						onChange={setView}
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
									<MessageSquareText aria-hidden="true" className="size-3.5" />
								),
							},
						]}
					/>
				</div>
			)}
			{responseCovered && (
				<section
					className="absolute inset-0 flex min-h-0 flex-col bg-surface-terminal p-4 pt-10"
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
	);
}
