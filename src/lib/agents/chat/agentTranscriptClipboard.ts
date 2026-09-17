import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { t } from "@/lib/i18n";
import {
	type ProviderConversationTranscript,
	readProviderConversationTranscript,
} from "@/lib/ipc/conversations";
import {
	createDureAgentConversationClient,
	type DureAgentConversationClient,
} from "@/lib/ipc/dureAgentConversation";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";
import { showErrorToast } from "@/lib/toast";
import type { Agent } from "@/types";
import {
	type AgentTranscriptEntryLimit,
	agentTranscriptFromProvider,
	collectAgentTranscript,
	formatAgentTranscript,
	type NativeAgentTranscriptSource,
	nativeAgentTranscriptSource,
} from "../../../../cli/lib/agent-transcript.mjs";

interface AgentTranscriptClipboardDependencies {
	createClient?: (options: {
		profileId: string;
	}) => Pick<DureAgentConversationClient, "read">;
	copyText?: typeof copyTextToClipboard;
	readProviderTranscript?: (
		provider: string,
		conversationId: string,
	) => Promise<ProviderConversationTranscript>;
}

interface StructuredAgentTranscriptSource {
	agentId: string;
	providerId: string;
	profile: AgentStructuredInteractionProfileV1;
}

/** Thin browser adapter around the shared transcript policy used by the CLI. */
export async function copyAgentTranscriptToClipboard(
	source: StructuredAgentTranscriptSource,
	entryLimit: AgentTranscriptEntryLimit,
	dependencies: AgentTranscriptClipboardDependencies = {},
): Promise<boolean> {
	const client = (
		dependencies.createClient ?? createDureAgentConversationClient
	)({
		profileId: source.profile.backendProfileId,
	});
	const transcript = await collectAgentTranscript({
		agentId: source.agentId,
		providerId: source.providerId,
		interactionSessionId: source.profile.interactionSessionId,
		entryLimit,
		readPage: async (request) => (await client.read(request)).read,
	});
	return (dependencies.copyText ?? copyTextToClipboard)(
		formatAgentTranscript(transcript),
	);
}

/** Native CLI panes normalize their exact provider record into the same model. */
export async function copyProviderTranscriptToClipboard(
	source: NativeAgentTranscriptSource,
	entryLimit: AgentTranscriptEntryLimit,
	dependencies: AgentTranscriptClipboardDependencies = {},
): Promise<boolean> {
	const transcript = agentTranscriptFromProvider({
		source,
		entryLimit,
		transcript: await (
			dependencies.readProviderTranscript ?? readProviderConversationTranscript
		)(source.provider, source.conversationId),
	});
	return (dependencies.copyText ?? copyTextToClipboard)(
		formatAgentTranscript(transcript),
	);
}

/** Builds the pane menu action only when one exact transcript authority exists. */
export function createPaneTranscriptCopyAction(
	agent: Agent | undefined,
	runtimeBinding?: unknown,
	/** The pane whose menu offered the copy, so a failure lands in it. */
	paneId?: string,
): ((entryLimit: AgentTranscriptEntryLimit) => void) | undefined {
	if (!agent) return undefined;
	const profile = agent.interactionProfile;
	const nativeSource =
		profile?.kind === "structured_protocol"
			? undefined
			: nativeAgentTranscriptSource(agent, runtimeBinding);
	const copy =
		profile?.kind === "structured_protocol"
			? (entryLimit: AgentTranscriptEntryLimit) =>
					copyAgentTranscriptToClipboard(
						{
							agentId: agent.id,
							providerId: agent.provider,
							profile,
						},
						entryLimit,
					)
			: nativeSource?.kind === "local"
				? (entryLimit: AgentTranscriptEntryLimit) =>
						copyProviderTranscriptToClipboard(nativeSource, entryLimit)
				: undefined;
	if (!copy) return undefined;
	return (entryLimit) => {
		void copy(entryLimit).catch((error) => {
			const message = t("workspace.paneMenu.copyTranscriptFailed", {
				error: String(error),
			});
			if (paneId) showErrorToast(message, { paneId });
			else showErrorToast(message);
		});
	};
}
