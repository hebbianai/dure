import { type ReactNode, useEffect } from "react";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { useNativeAgentResponseState } from "@/components/agents/useAgentDisplayState";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import { Button } from "@/components/ui/button";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { nativeFinalResponse } from "@/lib/agents/nativeFinalResponse";
import { t } from "@/lib/i18n";
import { readProviderConversationTranscript } from "@/lib/ipc/conversations";
import type { Agent } from "@/types";
import { nativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

/** Both docked and detached panes keep the same native terminal mounted and
 * sized. Only its presentation is covered; input/recovery never changes owners. */
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
	const eligible =
		mode === "pro" &&
		enabled &&
		!disabled &&
		provider &&
		conversationId &&
		runtime?.lifecycle === "running" &&
		agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
		agent.runtimeBinding?.conversationIdentity?.terminalEpoch ===
			runtime.terminalEpoch &&
		runtime.attention === "none" &&
		(state === "working" || state === "waiting");
	const completed = count !== undefined && /^[1-9]\d*$/.test(count);
	const shouldRead = Boolean(eligible && completed && state === "waiting");

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
	const covered = Boolean(
		eligible &&
			revealed !== state &&
			(state === "working" || (completed && response !== null)),
	);
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
			{covered && (
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
	);
}
