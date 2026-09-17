import {
	hmux,
	type HmuxExactSessionInspectionResult,
	type HmuxExactSessionTarget,
	type HmuxSessionSummary,
} from "@/lib/ipc";

/** Match the Hmux exact-probe request bound. Batch-v3 fans one request across
 * the process-wide worker limit; smaller WebView slices multiply helper waves. */
export const EXACT_HMUX_INSPECTION_BATCH_LIMIT = 128;

export function exactHmuxSessionTargetKey(
	target: HmuxExactSessionTarget,
): string {
	return `${target.workspaceId}\0${target.sessionId}`;
}

function resultIdentity(result: HmuxExactSessionInspectionResult): string {
	return result.outcome === "found"
		? exactHmuxSessionTargetKey(result.session)
		: exactHmuxSessionTargetKey(result);
}

function validateExactResults(
	targets: readonly HmuxExactSessionTarget[],
	results: readonly HmuxExactSessionInspectionResult[],
): void {
	if (results.length !== targets.length) {
		throw new Error("hmux_exact_inspection_result_count_mismatch");
	}
	for (let index = 0; index < targets.length; index += 1) {
		if (
			resultIdentity(results[index]) !==
			exactHmuxSessionTargetKey(targets[index])
		) {
			throw new Error("hmux_exact_inspection_result_identity_mismatch");
		}
	}
}

export async function inspectHmuxSessionsExact(
	targets: readonly HmuxExactSessionTarget[],
): Promise<HmuxExactSessionInspectionResult[]> {
	const results: HmuxExactSessionInspectionResult[] = [];
	for (
		let offset = 0;
		offset < targets.length;
		offset += EXACT_HMUX_INSPECTION_BATCH_LIMIT
	) {
		const batch = targets.slice(
			offset,
			offset + EXACT_HMUX_INSPECTION_BATCH_LIMIT,
		);
		const inspected = await hmux.inspectSessionsExact(batch);
		validateExactResults(batch, inspected);
		results.push(...inspected);
	}
	return results;
}

export function foundExactHmuxSessions(
	results: readonly HmuxExactSessionInspectionResult[],
): HmuxSessionSummary[] {
	return results.flatMap((result) =>
		result.outcome === "found" ? [result.session] : [],
	);
}

export function sessionFromExactHmuxInspection(
	result: HmuxExactSessionInspectionResult,
): HmuxSessionSummary | undefined {
	switch (result.outcome) {
		case "found":
			return result.session;
		case "not_found":
			return undefined;
		case "lookup_failed":
			throw new Error(`hmux_exact_inspection_lookup_failed:${result.errorCode}`);
		case "unprobed":
			throw new Error("hmux_exact_inspection_unprobed");
	}
}

/** Resolve one exact identity. Only `not_found` is absence; unreadable or
 * unprobed discovery must remain an error so callers cannot retire/recreate a
 * session from an unknown observation. */
export async function inspectHmuxSessionExact(
	target: HmuxExactSessionTarget,
): Promise<HmuxSessionSummary | undefined> {
	const [result] = await inspectHmuxSessionsExact([target]);
	return sessionFromExactHmuxInspection(result);
}
