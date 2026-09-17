export interface StructuredAgentRuntimeAttachmentFence {
	readonly sessionId: string;
	readonly terminalEpoch: string;
	readonly attachmentToken: string;
}

export type StructuredAgentRuntimeProjectionDisposition =
	| "applied"
	| "stale_attachment"
	| "epoch_mismatch";

/** Installs one already-validated Tauri projection under the exact structured
 * attachment authority. The caller supplies the current token; this helper
 * owns no registry or fallback authority. */
export function applyStructuredAgentProjection<
	Projection extends { readonly terminalEpoch: string },
>(input: {
	readonly projection: Projection;
	readonly attachment: StructuredAgentRuntimeAttachmentFence;
	readonly currentAttachmentToken: string | undefined;
	readonly commit: (sessionId: string, projection: Projection) => void;
}): StructuredAgentRuntimeProjectionDisposition {
	if (input.currentAttachmentToken !== input.attachment.attachmentToken) {
		return "stale_attachment";
	}
	if (input.projection.terminalEpoch !== input.attachment.terminalEpoch) {
		return "epoch_mismatch";
	}
	input.commit(input.attachment.sessionId, input.projection);
	return "applied";
}
