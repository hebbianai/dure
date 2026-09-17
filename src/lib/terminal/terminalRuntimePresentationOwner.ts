import { HMUX_MANAGED_GENERATION_FIELDS } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { TerminalPaneBindingV1 } from "./terminalBinding";

/** Pane-local recipient identity, not permission to execute against this runtime. */
export function terminalRuntimePresentationOwnerKey(
	binding: TerminalPaneBindingV1,
): string {
	return JSON.stringify([
		binding.runtime,
		binding.source,
		binding.hostId,
		binding.sessionId,
		binding.workspaceId,
		binding.runtime === "hmux_managed_v1"
			? [
					binding.backendProfileId ?? null,
					binding.createIdempotencyKey ?? null,
					binding.stopFence
						? HMUX_MANAGED_GENERATION_FIELDS.map(
								(field) => binding.stopFence?.[field] ?? null,
							)
						: null,
				]
			: null,
	]);
}
