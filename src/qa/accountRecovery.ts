import type { AgentInteractionBindingV1 } from "@/lib/agents/chat/agentConversationContract";
import { readFile } from "@/lib/ipc";
import { createAccountRecoveryClient } from "@/lib/ipc/dureAccountRecovery";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import { qaLog } from "@/lib/qa/qaLog";

function requireFact(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

/** An optional natural quota observation; no provider errors or credentials are
 * modified. The caller has unmounted every conversation view. */
export async function exerciseAccountRecovery({
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
		limitedProfileDirectoryName?: string;
	};
	if (!configuration.limitedProfileDirectoryName) return {};
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
			"Recovery lost its conversation",
		);
		return observed.read.page;
	};
	const before = await read();
	const allowed = before.binding.executionProfile;
	requireFact(
		allowed.kind === "credential_reference" && allowed.credential_generation,
		"Recovery needs an explicitly registered target",
	);
	const settings = createAccountRecoveryClient(authority.profileId);
	const snapshot = await settings.get("codex");
	await settings.put(
		{
			providerId: "codex",
			expectedRevision: snapshot.policy?.revision ?? 0,
			idempotencyKey: `qa-recovery-policy-${proof}`,
			enabled: true,
			accounts: [
				{
					name: "QA allowed account",
					profile: {
						schemaVersion: 1,
						providerId: "codex",
						referenceId: allowed.reference_id,
						credentialGeneration: allowed.credential_generation,
					},
				},
			],
		},
		snapshot.routeAuthority,
	);
	const limited = await registerDureProviderCredentialProfile(
		{
			providerId: "codex",
			referenceId: "qa-limited",
			profileDirectoryName: configuration.limitedProfileDirectoryName,
		},
		{ routeAuthority: authority },
	);
	await createDureAgentRuntimeClient({
		profileId: authority.profileId,
	}).transition({
		agentId: binding.agentId,
		targetInteractionProfile: "structured_protocol",
		targetExecutionProfile: limited,
		routeAuthority: authority,
	});
	const source = await read();
	const marker = `QA_RECOVERY_${proof}`;
	const input = `Reply exactly ${marker}. Do not use tools.`;
	await conversation.startTurn(
		{
			schemaVersion: 1,
			interactionSessionId: binding.interactionSessionId,
			runtime: source.binding.runtime,
			turnId: `quota-turn-${proof}`,
			clientMessageId: `quota-input-${proof}`,
			input,
			requestedAtMs: Date.now(),
		},
		authority,
	);
	const after = await wait(
		"backend quota recovery without a conversation view",
		async () => {
			const page = await read();
			requireFact(
				!page.recovery?.stopped,
				`Recovery stopped: ${JSON.stringify(page.recovery?.stopped)}`,
			);
			return page.recovery?.turnState === "accepted" &&
				!page.activeTurn &&
				page.rows.some(
					({ item }) =>
						item.body.type === "message" &&
						item.body.role === "assistant" &&
						item.body.markdown.trim() === marker,
				)
				? page
				: undefined;
		},
	);
	requireFact(
		after.rows.some(
			({ item }) =>
				item.body.type === "lifecycle" &&
				item.body.state === "turn_failed" &&
				item.body.detail === "usage_limit" &&
				item.clientMessageId === `quota-input-${proof}`,
		),
		"The source never reported a natural quota limit",
	);
	requireFact(
		JSON.stringify(after.binding.executionProfile) === JSON.stringify(allowed),
		"Recovery chose an unoffered account",
	);
	requireFact(
		after.binding.providerConversationRef ===
			before.binding.providerConversationRef,
		"Recovery changed the provider conversation",
	);
	const recoveredInput = after.rows.filter(
		({ item }) =>
			item.clientMessageId === after.recovery?.attemptId &&
			item.body.type === "message" &&
			item.body.role === "user",
	);
	requireFact(
		recoveredInput.length === 1 &&
			recoveredInput[0].item.body.type === "message" &&
			recoveredInput[0].item.body.markdown === input,
		"Recovery did not retain the request exactly once",
	);
	qaLog("account-recovery", {
		proof,
		naturalQuota: true,
		noConversationView: true,
		agentId: binding.agentId,
		interactionSessionId: binding.interactionSessionId,
		recovery: after.recovery,
		originalInput: input,
		providerReply: marker,
	});
	return { backendAccountRecovery: true };
}
