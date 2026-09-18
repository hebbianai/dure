import type {
	AgentInteractionBindingV1,
	AgentStartTurnIntentV1,
} from "@/lib/agents/chat/agentConversationContract";
import { readFile } from "@/lib/ipc";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import { asRecord } from "@/lib/payloadGuards";
import { qaLog } from "@/lib/qa/qaLog";

function requireFact(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

/** Real provider replacement with accepted work, using the normal credential
 * registration and runtime transition commands. The caller has closed its view. */
export async function exerciseAccountQueue({
	home,
	proof,
	binding,
	authority,
	wait,
}: {
	home: string;
	proof: string;
	binding: AgentInteractionBindingV1;
	authority: DureBackendRouteAuthorityV1;
	wait: <T>(
		label: string,
		observe: () => T | Promise<T>,
	) => Promise<NonNullable<T>>;
}) {
	const configuration = JSON.parse(
		(await readFile(`${home}/slack-queue-account.json`)).content,
	) as {
		profileDirectoryName: string;
		referenceId: string;
		distinctProviderAccounts: boolean;
	};
	const target = await registerDureProviderCredentialProfile(
		{
			providerId: "codex",
			referenceId: configuration.referenceId,
			profileDirectoryName: configuration.profileDirectoryName,
		},
		{ routeAuthority: authority },
	);
	const conversation = createDureAgentConversationClient({
		profileId: authority.profileId,
	});
	const read = async () => {
		const observed = await conversation.read({
			schemaVersion: 1,
			interactionSessionId: binding.interactionSessionId,
			direction: "tail",
			cursor: null,
			limit: 128,
		});
		requireFact(
			observed.read.type === "page",
			"Account queue lost its timeline",
		);
		return observed.read.page;
	};
	const before = await read();
	const active: AgentStartTurnIntentV1 = {
		schemaVersion: 1,
		interactionSessionId: binding.interactionSessionId,
		runtime: before.binding.runtime,
		turnId: `account-active-turn-${proof}`,
		clientMessageId: `account-active-input-${proof}`,
		input:
			"Run python3 queue-account-barrier.py. Do not run other tools or change files.",
		requestedAtMs: Date.now(),
	};
	await conversation.startTurn(active, authority);
	await wait("account source running its barrier tool", async () => {
		const page = await read();
		for (const pending of page.pendingRequests) {
			const command = asRecord(asRecord(pending.request.payload)?.input);
			requireFact(
				pending.request.kind === "permission" &&
					command?.command ===
						"/bin/zsh -lc 'python3 queue-account-barrier.py'",
				"The account fixture requested an unexpected tool",
			);
			await conversation.answerPending(
				{
					schemaVersion: 1,
					interactionSessionId: pending.interactionSessionId,
					runtime: pending.runtime,
					requestId: pending.request.requestId,
					clientMessageId: pending.request.clientMessageId,
					idempotencyKey: `account-barrier-${proof}-${pending.request.requestId}`,
					answer: { decision: "allow" },
					requestedAtMs: pending.request.createdAtMs,
				},
				authority,
			);
		}
		if (page.activeTurn?.turnId !== active.turnId) return undefined;
		try {
			return (await readFile(`${home}/project/queue-account-active`))
				.content === "waiting"
				? page
				: undefined;
		} catch {
			return undefined;
		}
	});
	const intents = [1, 2].map(
		(index): AgentStartTurnIntentV1 => ({
			...active,
			turnId: `account-queued-turn-${index}-${proof}`,
			clientMessageId: `account-queued-input-${index}-${proof}`,
			input: `Reply exactly QA_ACCOUNT_${index}_${proof}. Do not use tools.`,
			requestedAtMs: Date.now(),
		}),
	);
	const receipts = [];
	for (const intent of intents) {
		const receipt = await conversation.enqueueTurn(intent, authority);
		requireFact(
			receipt.state === "queued",
			"Input was not queued before switch",
		);
		receipts.push(receipt);
	}
	qaLog("slack-share-progress", { proof, phase: "account-queue-admitted" });
	const runtime = createDureAgentRuntimeClient({
		profileId: authority.profileId,
	});
	const source = await runtime.inspectExact(binding.agentId, authority);
	requireFact(
		source.state === "stable" &&
			source.interactionProfile === "structured_protocol" &&
			source.interactionSessionId === binding.interactionSessionId,
		"The account switch source is no longer the owned structured runtime",
	);
	const transition = await runtime.transition({
		agentId: binding.agentId,
		expectedSourceRevision: source.selectionRevision,
		targetInteractionProfile: "structured_protocol",
		targetExecutionProfile: target,
		// Only this disposable active tool is explicitly discarded.
		sourceStopPolicy: "discard",
		routeAuthority: authority,
	});
	requireFact(
		transition.interactionProfile === "structured_protocol" &&
			transition.interactionSessionId === binding.interactionSessionId &&
			transition.providerConversationRef ===
				before.binding.providerConversationRef,
		"Account switch replaced the conversation identity",
	);
	const completed = await wait(
		"queued inputs on the replacement account",
		async () => {
			const page = await read();
			const queuedRows = page.rows.filter(({ item }) =>
				intents.some((intent) => intent.turnId === item.turnId),
			);
			requireFact(
				!queuedRows.some(
					({ item }) =>
						item.body.type === "lifecycle" &&
						["turn_failed", "turn_canceled"].includes(item.body.state),
				),
				"A queued turn failed on the replacement account",
			);
			return !page.activeTurn &&
				intents.every((intent) =>
					queuedRows.some(
						({ item }) =>
							item.turnId === intent.turnId &&
							item.body.type === "lifecycle" &&
							item.body.state === "turn_completed",
					),
				)
				? page
				: undefined;
		},
	);
	requireFact(
		completed.binding.runtime.runtimeGeneration !==
			before.binding.runtime.runtimeGeneration &&
			completed.binding.runtime.providerEpoch !==
				before.binding.runtime.providerEpoch &&
			JSON.stringify(completed.binding.executionProfile) ===
				JSON.stringify(target),
		"Accepted input did not reach the new credential runtime",
	);
	requireFact(
		completed.queuedInputs?.inputs.length === 0 &&
			completed.pendingRequests.length === 0,
		"Replacement left pending input or the retired tool permission",
	);
	const delivered = completed.rows
		.filter(
			({ item }) =>
				item.body.type === "message" &&
				item.body.role === "user" &&
				intents.some(
					(intent) => intent.clientMessageId === item.clientMessageId,
				),
		)
		.map(({ item }) => item.clientMessageId);
	requireFact(
		JSON.stringify(delivered) ===
			JSON.stringify(intents.map((intent) => intent.clientMessageId)),
		"Account switch reordered or duplicated accepted inputs",
	);
	for (const [index, intent] of intents.entries()) {
		requireFact(
			completed.rows.some(
				({ item }) =>
					item.turnId === intent.turnId &&
					item.body.type === "message" &&
					item.body.role === "assistant" &&
					item.body.markdown.trim() === `QA_ACCOUNT_${index + 1}_${proof}`,
			),
			"The replacement provider did not answer the queued input",
		);
		const replay = await conversation.enqueueTurn(intent, authority);
		requireFact(
			replay.state === "dispatched" &&
				JSON.stringify(replay.intent) ===
					JSON.stringify(receipts[index].intent),
			"Old-runtime admission replay changed the accepted intent or dispatched state",
		);
		const observed = await conversation.inspectInput(
			{
				schemaVersion: 1,
				interactionSessionId: binding.interactionSessionId,
				clientMessageId: intent.clientMessageId,
			},
			authority,
		);
		requireFact(
			observed?.kind === "queued" &&
				observed.state === "dispatched" &&
				JSON.stringify(observed.intent) === JSON.stringify(intent),
			"Dispatch rewrote the original accepted intent",
		);
	}
	const replayed = await read();
	requireFact(
		JSON.stringify(replayed.finalCursor) ===
			JSON.stringify(completed.finalCursor) &&
			!replayed.activeTurn &&
			replayed.queuedInputs?.inputs.length === 0,
		"Replaying an accepted input scheduled another provider turn",
	);
	qaLog("slack-account-queue", {
		proof,
		before: before.binding,
		after: completed.binding,
		receipts,
		rows: completed.rows.filter(
			({ cursor }) => cursor.sequence > before.finalCursor.sequence,
		),
		distinctProviderAccounts: configuration.distinctProviderAccounts,
	});
	return {
		queuedAcrossRuntimeReplacement: true,
		credentialProfileChanged: true,
		distinctProviderAccounts: configuration.distinctProviderAccounts,
	};
}
