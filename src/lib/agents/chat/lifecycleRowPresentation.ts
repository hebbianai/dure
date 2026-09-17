/** Presentation policy for standalone lifecycle rows. The quiet-normal rule:
 * expected transitions are not announced — a ready session shows itself by
 * accepting input, a clean exit needs no payload — while failures and
 * abnormal exits stay visible. Raw provider detail (e.g. the exit-status
 * JSON) is humanized instead of leaking into the transcript. */
export type LifecycleRowPresentation =
	| { kind: "hidden" }
	| { kind: "notice"; detail: string | null; failed: boolean };

const HIDDEN_STATES = new Set([
	// The composer becoming available already says this.
	"session_ready",
	// Turn transitions are presented by turn projection (footers); a stray
	// unmatched row is bookkeeping, not conversation.
	"turn_started",
	"turn_completed",
	"turn_canceled",
]);

function humanizedExitDetail(detail: string | null): string | null {
	if (detail === null) return null;
	try {
		const parsed: unknown = JSON.parse(detail);
		if (typeof parsed !== "object" || parsed === null) return detail;
		const status = parsed as { code?: unknown; signal?: unknown };
		if (status.code === 0 && !status.signal) return null;
		if (typeof status.signal === "string" && status.signal) {
			return `signal ${status.signal}`;
		}
		if (typeof status.code === "number") return `exit ${status.code}`;
		return detail;
	} catch {
		return detail;
	}
}

export function presentLifecycleRow(
	state: string,
	detail: string | null,
): LifecycleRowPresentation {
	if (HIDDEN_STATES.has(state)) return { kind: "hidden" };
	if (state === "session_exited") {
		// A clean exit is the norm and says nothing the reader must act on;
		// only an abnormal status keeps the row.
		const humanized = humanizedExitDetail(detail);
		if (humanized === null) return { kind: "hidden" };
		return { kind: "notice", detail: humanized, failed: false };
	}
	if (state === "session_failed" || state === "turn_failed") {
		return { kind: "notice", detail, failed: true };
	}
	// Unknown states stay visible — failing loudly beats hiding a new signal.
	return { kind: "notice", detail, failed: false };
}
