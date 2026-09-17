import { describe, expect, it } from "vitest";
import {
	clearQaPerformanceEvidence,
	freezeQaPerformanceEvidence,
	readQaPerformanceEvidence,
} from "./qaPerformanceEvidence";

describe("QA performance evidence", () => {
	it("retains the workload report independently from later live cleanup", () => {
		const host = {};
		const evidence = {
			report: { totals: { terminalSurfaces: 15 } },
			frameBudget: { pending: 0 },
		};

		freezeQaPerformanceEvidence(host, evidence);
		expect(readQaPerformanceEvidence(host)).toBe(evidence);

		clearQaPerformanceEvidence(host);
		expect(readQaPerformanceEvidence(host)).toBeUndefined();
	});
});
