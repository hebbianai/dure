import {
	loadProviderConversationDetails,
	type ProviderConversationDetailsTarget,
	type ProviderConversationInputAuthority,
} from "@/lib/agents/providerConversationDiscovery";
import { providerConversationTargetForAgent } from "@/lib/agents/providerConversationTarget";
import type { Agent, Project, SshHostConfig } from "@/types";

export type ProviderConversationInputAuthorityErrorCode =
	| "provider_conversation_controlled_by_parent"
	| "provider_conversation_input_authority_unverified";

export class ProviderConversationInputAuthorityError extends Error {
	readonly name = "ProviderConversationInputAuthorityError";
	readonly code: ProviderConversationInputAuthorityErrorCode;
	readonly conversationId: string;
	readonly parentConversationId?: string;

	constructor(
		readonly target: ProviderConversationDetailsTarget,
		readonly authority: Exclude<
			ProviderConversationInputAuthority,
			{ kind: "independent" }
		>,
	) {
		const parentConversationId =
			authority.kind === "controlled_by_parent"
				? authority.parentConversationId
				: undefined;
		super(
			parentConversationId
				? `provider conversation is controlled by parent ${parentConversationId}`
				: "provider conversation input authority is unverified",
		);
		this.code = parentConversationId
			? "provider_conversation_controlled_by_parent"
			: "provider_conversation_input_authority_unverified";
		this.conversationId = target.conversationId;
		this.parentConversationId = parentConversationId;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Treat an absent or malformed adapter projection as unverified. Admission
 * callers can then fail closed without teaching the rehost core provider
 * transcript formats. */
export function providerConversationInputAuthority(
	value: unknown,
): ProviderConversationInputAuthority {
	if (!isRecord(value)) return { kind: "unverified" };
	if (value.kind === "independent") return { kind: "independent" };
	if (
		value.kind === "controlled_by_parent" &&
		typeof value.parentConversationId === "string" &&
		value.parentConversationId.trim()
	) {
		return {
			kind: "controlled_by_parent",
			parentConversationId: value.parentConversationId,
		};
	}
	return { kind: "unverified" };
}

export function providerConversationDetailsTarget(
	agent: Agent,
	projects: readonly Project[],
): ProviderConversationDetailsTarget {
	const target = providerConversationTargetForAgent(
		agent,
		projects.find((project) => project.id === agent.projectId),
	);
	if (!target) throw new Error("provider_conversation_target_required");
	return target;
}

async function inspectProviderConversationInputAuthority(
	target: ProviderConversationDetailsTarget,
	hosts: readonly SshHostConfig[],
): Promise<ProviderConversationInputAuthority> {
	const details = await loadProviderConversationDetails(target, hosts);
	return providerConversationInputAuthority(details.inputAuthority);
}

export async function requireIndependentProviderConversationInput(
	target: ProviderConversationDetailsTarget,
	hosts: readonly SshHostConfig[],
): Promise<void> {
	const authority = await inspectProviderConversationInputAuthority(target, hosts);
	if (authority.kind === "independent") return;
	throw new ProviderConversationInputAuthorityError(target, authority);
}

export async function requireIndependentProviderConversationInputForAgent(
	agent: Agent,
	projects: readonly Project[],
	hosts: readonly SshHostConfig[],
): Promise<void> {
	return requireIndependentProviderConversationInput(
		providerConversationDetailsTarget(agent, projects),
		hosts,
	);
}
