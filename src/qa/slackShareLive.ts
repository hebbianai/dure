import type {
	AgentInteractionBindingV1,
	AgentTimelinePageV1,
} from "@/lib/agents/chat/agentConversationContract";
import { readFile } from "@/lib/ipc";
import type { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { qaLog } from "@/lib/qa/qaLog";

export interface LiveSlackConfiguration {
	teamId: string;
	channelId: string;
	appToken: string;
	botToken: string;
}

function requireFact(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

/** The operator sends real Slack inputs and confirms the actual Slack API
 * observation. Native IPC drives the intervening Dure-side direction change. */
export async function exerciseLiveSlackShare({
	proof,
	home,
	binding,
	conversation,
	completed,
	wait,
	threadTs,
}: {
	proof: string;
	home: string;
	binding: AgentInteractionBindingV1;
	conversation: ReturnType<typeof createDureAgentConversationClient>;
	threadTs: string;
	completed: (
		binding: AgentInteractionBindingV1,
		marker: string,
	) => Promise<AgentTimelinePageV1>;
	wait: <T>(
		label: string,
		observe: () => T | Promise<T>,
	) => Promise<NonNullable<T>>;
}) {
	const progress = (phase: string, extra = {}) =>
		qaLog("slack-share-live", {
			proof,
			phase,
			agentId: binding.agentId,
			threadTs,
			...extra,
		});
	const assistant = (page: AgentTimelinePageV1, marker: string) => {
		const body = page.rows.find(
			({ item }) =>
				item.body.type === "message" &&
				item.body.role === "assistant" &&
				item.body.markdown.includes(marker),
		)?.item.body;
		requireFact(body?.type === "message", "Actual assistant reply is missing");
		return body.markdown.trim();
	};
	const firstMarker = `QA_SLACK_FIRST_${proof}`;
	progress("awaiting-slack-request", { home, firstMarker, binding });
	const first = await completed(binding, firstMarker);
	requireFact(
		(await readFile(`${home}/project/result.txt`)).content === "43\n",
		"Slack input did not produce the verified total",
	);
	const { binding: current, routeAuthority } = await conversation.inspect(
		binding.agentId,
	);
	requireFact(current, "The shared conversation disappeared");
	const secondMarker = `QA_DURE_CHANGED_${proof}`;
	await conversation.startTurn(
		{
			schemaVersion: 1,
			interactionSessionId: current.interactionSessionId,
			runtime: current.runtime,
			turnId: `live-dure-${proof}`,
			clientMessageId: `live-dure-${proof}`,
			input: `Change direction for this personal integration test. In the same task, update result.txt to contain exactly Total parcels: 43 followed by a newline. Preserve counts.txt, verify the actual files, then reply with ${secondMarker} and the final content. Do not access files outside this repository or use the network.`,
			requestedAtMs: Date.now(),
		},
		routeAuthority,
	);
	progress("dure-direction-submitted", { secondMarker });
	const second = await completed(current, secondMarker);
	requireFact(
		(await readFile(`${home}/project/result.txt`)).content ===
			"Total parcels: 43\n",
		"Dure direction did not update the same artifact",
	);
	const finalMarker = `QA_SLACK_FINAL_${proof}`;
	progress("awaiting-slack-followup", { finalMarker });
	const final = await completed(current, finalMarker);
	requireFact(
		final.binding.interactionSessionId === binding.interactionSessionId &&
			final.binding.providerConversationRef === binding.providerConversationRef,
		"The live round trip changed the conversation",
	);
	requireFact(
		(await readFile(`${home}/project/counts.txt`)).content === "17\n26\n",
		"Source counts changed",
	);
	requireFact(
		(await readFile(`${home}/project/result.txt`)).content ===
			"Total parcels: 43\n",
		"Final artifact changed unexpectedly",
	);
	const assistantReplies = [
		assistant(first, firstMarker),
		assistant(second, secondMarker),
		assistant(final, finalMarker),
	];
	progress("awaiting-slack-observation", { assistantReplies });
	const confirmation = await wait("actual Slack observation", async () => {
		let source: string;
		try {
			source = (await readFile(`${home}/slack-live-observation.json`)).content;
		} catch {
			return undefined;
		}
		return JSON.parse(source) as {
			proof: string;
			threadTs: string;
			botUserId: string;
			matchingThreads: number;
			messages: { text: string; ts: string; user: string }[];
		};
	});
	requireFact(
		confirmation.proof === proof,
		"Slack observation belongs to another run",
	);
	requireFact(
		confirmation.threadTs === threadTs && confirmation.matchingThreads === 1,
		"Slack sharing duplicated or changed the thread",
	);
	for (const reply of assistantReplies) {
		requireFact(
			confirmation.messages.some(
				(message) =>
					message.user === confirmation.botUserId &&
					message.text.trim() === reply,
			),
			"Actual Slack did not contain the observed assistant reply",
		);
	}
	requireFact(
		!JSON.stringify(confirmation).includes(`QA_PRIVATE_${proof}`),
		"Private history reached Slack",
	);
	return {
		binding: final.binding,
		threadTs: confirmation.threadTs,
		assistantReply: assistantReplies[2],
		assistantReplies,
		outboundMessages: confirmation.messages.filter(
			(message) => message.user === confirmation.botUserId,
		).length,
		artifact: "Total parcels: 43\n",
	};
}
