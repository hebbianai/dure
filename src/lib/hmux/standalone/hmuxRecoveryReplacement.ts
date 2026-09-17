import type { HmuxSessionSummary } from "@/lib/ipc";

/** A recovery target is safe to publish only after the backend has proved a
 * fresh writable handshake. Presentation retargeting treats older or stale
 * receipts as data, never as authority to move a pane. */
export function isWritableHealthyStandaloneReplacement(
	replacement: HmuxSessionSummary,
): boolean {
	return (
		replacement.sessionClass === "standalone" &&
		replacement.lifecycle === "ready" &&
		(replacement.health === "current_healthy" ||
			replacement.health === "compatible_old_healthy") &&
		replacement.inputAllowed === true &&
		replacement.detachOnly === false
	);
}
