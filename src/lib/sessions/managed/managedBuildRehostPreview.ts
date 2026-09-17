import type { Provider } from "@/types";

export interface ManagedBuildRehostPreviewV1 {
	schemaVersion: 1;
	location: "local" | "ssh";
	providerId: Provider;
	conversationId: string;
	/** Non-secret digest of the exact source Host generation and stop fence. */
	sourceGeneration: string;
	sourceBuildId: string;
	targetBuildId: string;
	/** Legacy Hosts cannot enumerate every CLI, SSH, or other-app client. */
	attachmentSafety: "initiating_dure_pane_only";
}

class ManagedBuildRehostPreviewError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "ManagedBuildRehostPreviewError";
	}
}

function required(value: string | undefined, reason: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new ManagedBuildRehostPreviewError(reason);
	return normalized;
}

/** Builds the non-mutating rehost receipt. SSH also permits a same-build
 * replacement to restore desktop integrations after reconnecting. */
export function managedBuildRehostPreview(input: {
	location: "local" | "ssh";
	providerId: Provider;
	conversationId: string;
	sourceGeneration?: string;
	sourceBuildId?: string;
	targetBuildId?: string;
}): ManagedBuildRehostPreviewV1 {
	const sourceBuildId = required(
		input.sourceBuildId,
		"managed_rehost_source_build_unknown",
	);
	const targetBuildId = required(
		input.targetBuildId,
		"managed_rehost_target_build_unknown",
	);
	if (input.location === "local" && sourceBuildId === targetBuildId) {
		throw new ManagedBuildRehostPreviewError("managed_rehost_already_current");
	}
	return {
		schemaVersion: 1,
		location: input.location,
		providerId: input.providerId,
		conversationId: required(
			input.conversationId,
			"conversation_identity_required",
		),
		sourceGeneration: required(
			input.sourceGeneration,
			"managed_rehost_source_generation_unknown",
		),
		sourceBuildId,
		targetBuildId,
		attachmentSafety: "initiating_dure_pane_only",
	};
}

export function sameManagedBuildRehostPreview(
	left: ManagedBuildRehostPreviewV1,
	right: ManagedBuildRehostPreviewV1,
): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.location === right.location &&
		left.providerId === right.providerId &&
		left.conversationId === right.conversationId &&
		left.sourceGeneration === right.sourceGeneration &&
		left.sourceBuildId === right.sourceBuildId &&
		left.targetBuildId === right.targetBuildId &&
		left.attachmentSafety === right.attachmentSafety
	);
}
