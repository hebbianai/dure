import type {
	QaRuntimeErrorCursor,
	QaRuntimeErrorSnapshot,
} from "./qaRuntimeErrorLedger";

export interface QaStatusRuntimeErrorProjection {
	state?: unknown;
	error?: unknown;
	runtimeErrorScope?: QaRuntimeErrorCursor;
	runtimeErrors?: QaRuntimeErrorSnapshot;
	[key: string]: unknown;
}

export function qaRuntimeErrorMessage(
	snapshot: QaRuntimeErrorSnapshot,
): string {
	const first = snapshot.errors[0];
	const message = first
		? `${first.kind}: ${first.message || "unknown runtime error"}`
		: "runtime errors were dropped before reporting";
	return first?.kind === "fatal_console"
		? `fatal ${message}`
		: `uncaught ${message}`;
}

export function projectQaStatusRuntimeErrors(
	status: QaStatusRuntimeErrorProjection | null,
	runtimeErrors: QaRuntimeErrorSnapshot,
): QaStatusRuntimeErrorProjection | null {
	if (!status) return null;
	if (runtimeErrors.total === 0) return { ...status, runtimeErrors };
	return {
		...status,
		state: "failed",
		error: qaRuntimeErrorMessage(runtimeErrors),
		runtimeErrors,
	};
}
