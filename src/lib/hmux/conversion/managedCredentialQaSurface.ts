import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import {
	type StructuredTerminalQaInputObservation,
	StructuredTerminalQaProbe,
} from "@/lib/terminal/qa/structuredTerminalQaProbe";
import { registerTerminalWindowFocusProbe } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";

const CODEX_KILL_DRAFT_TO_CURSOR = "\u0015";

export interface ManagedCredentialQaSurfaceLifecycle {
	connections: number;
	disconnections: number;
	hydrations: number;
	synchronizations: number;
	gridTransitions: TerminalGrid[];
	errors: string[];
}

export interface TerminalGrid {
	columns: number;
	rows: number;
	fitColumns?: number;
	fitRows?: number;
	fitDimensionsMatch?: boolean;
	viewportFillsContainer: boolean;
}

export interface ManagedCredentialTargetRehostEvidence {
	readonly before: ManagedCredentialQaSurfaceLifecycle;
	readonly after: ManagedCredentialQaSurfaceLifecycle;
	readonly inputBefore?: StructuredTerminalQaInputObservation;
	readonly inputAfter?: StructuredTerminalQaInputObservation;
}

/** Tracks one real structured terminal attachment during credential-switch QA. */
export class ManagedCredentialQaSurface {
	private readonly lifecycle: ManagedCredentialQaSurfaceLifecycle = {
		connections: 0,
		disconnections: 0,
		hydrations: 0,
		synchronizations: 0,
		gridTransitions: [],
		errors: [],
	};
	private readonly probe: StructuredTerminalQaProbe;
	private readonly unregister: () => void;

	constructor(desktopId: string, panelId: string) {
		const surfaceId = hmuxPaneOwnerId(
			getCurrentWebviewWindow().label,
			desktopId,
			panelId,
		);
		this.probe = new StructuredTerminalQaProbe(surfaceId, {
			onConnected: () => {
				this.lifecycle.connections += 1;
				return () => {
					this.lifecycle.disconnections += 1;
				};
			},
			onFocused: () => {},
			onHydrationChange: (hydrating) => {
				if (hydrating) this.lifecycle.hydrations += 1;
			},
			onSynchronized: () => {
				this.lifecycle.synchronizations += 1;
			},
			onPresented: (state) => {
				const grid = structuredTerminalGrid(state);
				const previous =
					this.lifecycle.gridTransitions[
						this.lifecycle.gridTransitions.length - 1
					];
				if (!previous || !equalTerminalGrid(previous, grid)) {
					this.lifecycle.gridTransitions.push(grid);
				}
			},
			onError: (error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!this.lifecycle.errors.includes(message)) {
					this.lifecycle.errors.push(message);
				}
			},
		});
		this.unregister = registerTerminalWindowFocusProbe(surfaceId, this.probe);
	}

	get connected(): boolean {
		return this.probe.connected;
	}

	async waitUntilReady(afterSynchronizations = -1): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (
			(!this.probe.connected ||
				this.lifecycle.synchronizations <= afterSynchronizations) &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
		}
		if (
			!this.probe.connected ||
			this.lifecycle.synchronizations <= afterSynchronizations
		) {
			throw new Error("managed structured surface did not become ready");
		}
	}

	async focus(): Promise<void> {
		await this.probe.focus();
	}

	waitForRetirement(): Promise<void> | undefined {
		return this.probe.hasSurfaceAttachment
			? this.probe.waitForSurfaceRetirement()
			: undefined;
	}

	observeMarker(marker: string): Promise<StructuredTerminalQaInputObservation> {
		// Codex keeps unsubmitted text in its composer. Replace the previous QA
		// marker so a second observation cannot be split by the TUI's redraw.
		return this.probe.observeInput(
			marker,
			`${CODEX_KILL_DRAFT_TO_CURSOR}${marker}`,
			{
				onReceipt: () => {},
				onProjection: () => {},
			},
		);
	}

	snapshot(): ManagedCredentialQaSurfaceLifecycle {
		return {
			...this.lifecycle,
			gridTransitions: [...this.lifecycle.gridTransitions],
			errors: [...this.lifecycle.errors],
		};
	}

	dispose(): void {
		this.unregister();
		this.probe.dispose();
	}
}

export function structuredTerminalGrid(
	observation:
		| StructuredTerminalQaInputObservation
		| StructuredTerminalQaInputObservation["projection"],
): TerminalGrid {
	const projection =
		"projection" in observation ? observation.projection : observation;
	return {
		columns: projection.columns,
		rows: projection.rows,
		fitColumns: projection.fitColumns,
		fitRows: projection.fitRows,
		fitDimensionsMatch: projection.fitDimensionsMatch,
		viewportFillsContainer: projection.viewportFill.fillsContainer,
	};
}

export function sameTerminalGrid(
	left: TerminalGrid,
	right: TerminalGrid,
): boolean {
	return (
		equalTerminalGrid(left, right) &&
		left.fitDimensionsMatch === true &&
		right.fitDimensionsMatch === true &&
		left.viewportFillsContainer &&
		right.viewportFillsContainer
	);
}

export function managedCredentialTargetSurfaceStayedContinuous({
	before,
	after,
	inputBefore,
	inputAfter,
}: ManagedCredentialTargetRehostEvidence): boolean {
	if (!inputBefore || !inputAfter) return false;
	const gridBefore = structuredTerminalGrid(inputBefore);
	const gridAfter = structuredTerminalGrid(inputAfter);
	return (
		before.errors.length === 0 &&
		after.errors.length === 0 &&
		inputAfter.receipt.attachmentIdentity !==
			inputBefore.receipt.attachmentIdentity &&
		sameTerminalGrid(gridBefore, gridAfter) &&
		after.gridTransitions
			.slice(before.gridTransitions.length)
			.every((transition) => sameTerminalGrid(transition, gridBefore)) &&
		inputBefore.markerCounts.painted === 1 &&
		inputBefore.markerCounts.projection === 1 &&
		inputAfter.markerCounts.painted === 1 &&
		inputAfter.markerCounts.projection === 1
	);
}

function equalTerminalGrid(left: TerminalGrid, right: TerminalGrid): boolean {
	return (
		left.columns === right.columns &&
		left.rows === right.rows &&
		left.fitColumns === right.fitColumns &&
		left.fitRows === right.fitRows &&
		left.fitDimensionsMatch === right.fitDimensionsMatch &&
		left.viewportFillsContainer === right.viewportFillsContainer
	);
}
