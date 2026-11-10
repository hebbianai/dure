import {
	appendPaneRecoveryDiagnostic,
	type PaneRecoveryDiagnosticInput,
} from "@/lib/ipc/paneRecoveryDiagnostics";
import {
	isPaneRecoveryDiagnosticCode,
	PANE_RECOVERY_UNCLASSIFIED_CODE,
} from "../../../../cli/lib/contracts/pane-recovery-diagnostics.mjs";
import { isDureDomainIdV1 } from "../../../../cli/lib/contracts/protocol-identity.mjs";

/** A message that is nothing but a code, or a code followed by its detail. */
const LEADING_CODE = /^([a-z][a-z0-9_]*)(?::|$)/;

function codeProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const code = (value as Record<string, unknown>)[key];
	return isPaneRecoveryDiagnosticCode(code) ? code : undefined;
}

/** The failure code a durable diagnostic may keep. Typed errors carry the
 * backend's own code; anything else keeps only a leading code token, so a
 * message, path or conversation text never reaches the journal. */
export function managedRecoveryFailureCode(cause: unknown): string {
	const typed =
		codeProperty(cause, "backendCode") ??
		codeProperty(
			typeof cause === "object" && cause !== null
				? (cause as { requestError?: unknown }).requestError
				: undefined,
			"code",
		) ??
		codeProperty(cause, "code");
	if (typed) return typed;
	const message =
		cause instanceof Error
			? cause.message
			: typeof cause === "string"
				? cause
				: "";
	const leading = LEADING_CODE.exec(message)?.[1];
	return isPaneRecoveryDiagnosticCode(leading)
		? leading
		: PANE_RECOVERY_UNCLASSIFIED_CODE;
}

/** Keep a failed Resume diagnosable after the pane that showed it is gone.
 * Recording is best effort and never changes the recovery outcome. */
export function recordManagedRecoveryFailure(
	stage: PaneRecoveryDiagnosticInput["stage"],
	agentId: string,
	cause: unknown,
	append: (
		event: PaneRecoveryDiagnosticInput,
	) => Promise<void> = appendPaneRecoveryDiagnostic,
): void {
	try {
		void append({
			stage,
			code: managedRecoveryFailureCode(cause),
			...(isDureDomainIdV1(agentId) ? { agentId } : {}),
		}).catch(() => {});
	} catch {
		// Diagnostics must never turn into a second recovery failure.
	}
}
