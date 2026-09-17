import type { TerminalResizeRenderObservation } from "./terminalResizeRenderObservation";

export interface TerminalResizeFrameSample {
	columns: number;
	rows: number;
	fitColumns?: number;
	fitRows?: number;
	fitDimensionsMatch?: boolean;
	atBottom: boolean;
	concealed: boolean;
	resizeRender?: TerminalResizeRenderObservation;
}

export interface TerminalResizeFrameViolationCounts {
	missingObservation: number;
	providerMismatch: number;
	bufferMismatch: number;
	dimensionsMismatch: number;
	containerFitMismatch: number;
	scrollIntentMismatch: number;
	footerMissing: number;
	generationRegression: number;
}

export interface TerminalResizeFrameIntegritySnapshot {
	samples: number;
	visibleFrames: number;
	concealedFrames: number;
	validFrames: number;
	violationFrames: number;
	lastGeneration: number | null;
	violations: TerminalResizeFrameViolationCounts;
}

type Violation = keyof TerminalResizeFrameViolationCounts;

const emptyViolations = (): TerminalResizeFrameViolationCounts => ({
	missingObservation: 0,
	providerMismatch: 0,
	bufferMismatch: 0,
	dimensionsMismatch: 0,
	containerFitMismatch: 0,
	scrollIntentMismatch: 0,
	footerMissing: 0,
	generationRegression: 0,
});

/**
 * Records distinct user-visible resize states, not polling frequency. Once a
 * provider frame has appeared, every unconcealed state must remain a complete,
 * monotonic frame. Transitional states are allowed only while the terminal is
 * explicitly concealed by its presentation-settling contract.
 */
export class TerminalResizeFrameIntegrity {
	private violations = emptyViolations();
	private lastSignature: string | undefined;
	private armed = false;
	private samples = 0;
	private visibleFrames = 0;
	private concealedFrames = 0;
	private validFrames = 0;
	private violationFrames = 0;
	private lastGeneration: number | null = null;

	constructor(
		private readonly expected: {
			provider: string;
			buffer: "alternate" | "normal";
		},
	) {}

	/** Starts a new user-visible measurement after fixture/window preparation. */
	reset(): void {
		this.violations = emptyViolations();
		this.lastSignature = undefined;
		this.armed = false;
		this.samples = 0;
		this.visibleFrames = 0;
		this.concealedFrames = 0;
		this.validFrames = 0;
		this.violationFrames = 0;
		this.lastGeneration = null;
	}

	observe(sample: TerminalResizeFrameSample): void {
		const signature = frameSignature(sample);
		if (signature === this.lastSignature) return;
		this.lastSignature = signature;
		this.samples += 1;
		if (sample.concealed) {
			this.concealedFrames += 1;
			return;
		}

		this.visibleFrames += 1;
		const observation = sample.resizeRender;
		if (!observation) {
			if (this.armed) this.recordViolations(["missingObservation"]);
			return;
		}
		this.armed = true;
		const violations: Violation[] = [];
		if (observation.provider !== this.expected.provider) {
			violations.push("providerMismatch");
		}
		if (observation.buffer !== this.expected.buffer) {
			violations.push("bufferMismatch");
		}
		if (!observation.dimensionsMatch) {
			violations.push("dimensionsMismatch");
		}
		// A replica can intentionally display the Host's canonical
		// grid in a differently sized window. Track that local-fit divergence as
		// diagnostic evidence, but do not classify a complete canonical frame as
		// corrupt. The phase contract validates fit on the active presentation only.
		if (sample.fitDimensionsMatch !== true) {
			this.violations.containerFitMismatch += 1;
		}
		if (sample.atBottom !== true) {
			violations.push("scrollIntentMismatch");
		}
		if (!observation.footerVisible) violations.push("footerMissing");
		if (
			this.lastGeneration !== null &&
			observation.generation < this.lastGeneration
		) {
			violations.push("generationRegression");
		}
		this.lastGeneration = Math.max(
			this.lastGeneration ?? observation.generation,
			observation.generation,
		);
		if (violations.length > 0) {
			this.recordViolations(violations);
			return;
		}
		this.validFrames += 1;
	}

	snapshot(): TerminalResizeFrameIntegritySnapshot {
		return {
			samples: this.samples,
			visibleFrames: this.visibleFrames,
			concealedFrames: this.concealedFrames,
			validFrames: this.validFrames,
			violationFrames: this.violationFrames,
			lastGeneration: this.lastGeneration,
			violations: { ...this.violations },
		};
	}

	private recordViolations(violations: readonly Violation[]) {
		this.violationFrames += 1;
		for (const violation of violations) this.violations[violation] += 1;
	}
}

function frameSignature(sample: TerminalResizeFrameSample) {
	const observation = sample.resizeRender;
	return [
		sample.concealed ? "concealed" : "visible",
		sample.columns,
		sample.rows,
		sample.fitColumns ?? "none",
		sample.fitRows ?? "none",
		sample.fitDimensionsMatch ?? "none",
		sample.atBottom,
		observation?.provider ?? "none",
		observation?.buffer ?? "none",
		observation?.generation ?? "none",
		observation?.reportedColumns ?? "none",
		observation?.reportedRows ?? "none",
		observation?.dimensionsMatch ?? "none",
		observation?.footerVisible ?? "none",
	].join(":");
}
