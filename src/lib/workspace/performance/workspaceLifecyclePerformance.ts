import type {
	AgentReadySample,
	PaneOpenSample,
} from "@/lib/workspace/performance/workspacePerformanceTypes";

const MAX_LIFECYCLE_SAMPLES = 96;

export interface AgentReadyTiming {
	readonly warm: boolean;
	readonly ok: boolean;
	readonly totalMs: number;
	readonly preflightMs: number;
	readonly createMs: number;
}

/** Owns bounded pane-open and provider-ready samples for one WebView. */
export class WorkspaceLifecyclePerformanceTracker {
	private readonly paneOpens: PaneOpenSample[] = [];
	private readonly paneOpensInFlight = new Map<string, PaneOpenSample>();
	private readonly paneKindsSeen = new Set<string>();
	private readonly agentReady: AgentReadySample[] = [];
	private readonly agentProvidersSeen = new Set<string>();
	private nextPaneSequence = 1;
	private nextAgentSequence = 1;

	constructor(private readonly now: () => number) {}

	/** Reopening an unfinished pane replaces its sample and restarts the clock. */
	beginPaneOpen(paneId: string, kind: string): void {
		const sample: PaneOpenSample = {
			sequence: this.nextPaneSequence++,
			paneId,
			kind,
			warm: this.paneKindsSeen.has(kind),
			startedAt: this.now(),
			openMs: null,
		};
		const stale = this.paneOpensInFlight.get(paneId);
		if (stale?.openMs === null) {
			const index = this.paneOpens.indexOf(stale);
			if (index !== -1) this.paneOpens.splice(index, 1);
		}
		this.paneOpensInFlight.set(paneId, sample);
		this.paneOpens.push(sample);
		if (this.paneOpens.length > MAX_LIFECYCLE_SAMPLES) this.paneOpens.shift();
	}

	markPaneReady(paneId: string): void {
		const sample = this.paneOpensInFlight.get(paneId);
		if (!sample || sample.openMs !== null) return;
		sample.openMs = Math.max(0, this.now() - sample.startedAt);
		this.paneKindsSeen.add(sample.kind);
		this.paneOpensInFlight.delete(paneId);
	}

	cancelPaneOpen(paneId: string): void {
		const sample = this.paneOpensInFlight.get(paneId);
		if (!sample || sample.openMs !== null) return;
		this.paneOpensInFlight.delete(paneId);
		const index = this.paneOpens.indexOf(sample);
		if (index !== -1) this.paneOpens.splice(index, 1);
	}

	agentSpawnWarm(provider: string): boolean {
		return this.agentProvidersSeen.has(provider);
	}

	/** Only a completed successful spawn makes later provider spawns warm. */
	recordAgentReady(provider: string, timing: AgentReadyTiming): void {
		this.agentReady.push({
			sequence: this.nextAgentSequence++,
			provider,
			warm: timing.warm,
			ok: timing.ok,
			totalMs: Math.max(0, timing.totalMs),
			preflightMs: Math.max(0, timing.preflightMs),
			createMs: Math.max(0, timing.createMs),
		});
		if (timing.ok) this.agentProvidersSeen.add(provider);
		if (this.agentReady.length > MAX_LIFECYCLE_SAMPLES) this.agentReady.shift();
	}

	snapshot(): {
		paneOpens: readonly PaneOpenSample[];
		agentReady: readonly AgentReadySample[];
	} {
		return {
			paneOpens: this.paneOpens.map((sample) => ({ ...sample })),
			agentReady: this.agentReady.map((sample) => ({ ...sample })),
		};
	}
}
