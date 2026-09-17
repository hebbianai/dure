import { fnv1a32Hex } from "@/lib/platform/hash";

export interface ManagedAgentFreshStartIdentity {
	recoveryId: string;
}

/** One durable fresh-start operation belongs to one source and logical action.
 * The first Host journal payload is authoritative; retry observations and
 * launch hints never select a different journal entry.
 */
export function managedAgentFreshStartIdentity(input: {
	sourceSessionId: string;
	workspaceId: string;
	/** Distinguishes separate user-selected operations on the same source. */
	operationKey?: string;
}): ManagedAgentFreshStartIdentity {
	const seedParts = [
		"managed-fresh-v3",
		"replace_ai_provider_with_fresh_conversation",
		input.workspaceId,
		input.sourceSessionId,
		input.operationKey ?? "default",
	];
	const seed = seedParts.join("\0");
	const suffix =
		fnv1a32Hex(seed) + fnv1a32Hex(`managed-fresh-successor\0${seed}`);
	const recoveryId = `fresh_${suffix}`;
	return { recoveryId };
}
