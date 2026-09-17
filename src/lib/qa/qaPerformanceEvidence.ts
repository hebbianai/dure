export interface QaPerformanceEvidence {
	report: unknown;
	frameBudget: unknown;
}

interface QaPerformanceEvidenceWindow {
	__DURE_WORKSPACE_PERFORMANCE_QA_EVIDENCE__?: QaPerformanceEvidence;
}

/** Keeps the final workload sample available while isolated surfaces detach. */
export function freezeQaPerformanceEvidence(
	host: object,
	evidence: QaPerformanceEvidence,
): void {
	(host as QaPerformanceEvidenceWindow).__DURE_WORKSPACE_PERFORMANCE_QA_EVIDENCE__ =
		evidence;
}

export function readQaPerformanceEvidence(
	host: object,
): QaPerformanceEvidence | undefined {
	return (host as QaPerformanceEvidenceWindow)
		.__DURE_WORKSPACE_PERFORMANCE_QA_EVIDENCE__;
}

export function clearQaPerformanceEvidence(
	host: object,
): void {
	delete (host as QaPerformanceEvidenceWindow)
		.__DURE_WORKSPACE_PERFORMANCE_QA_EVIDENCE__;
}
