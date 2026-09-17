import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import { registerTerminalStableDiagnostic } from "@/lib/terminal/qa/terminalStableDiagnostics";
import {
	StructuredTerminalQaProbe,
	type StructuredTerminalQaInputObservation,
} from "@/lib/terminal/qa/structuredTerminalQaProbe";
import { registerTerminalWindowFocusProbe } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";
import type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";
import type {
	TerminalQaInputReceipt,
} from "@/lib/terminal/terminalWindowFocusProbe";
import {
	type TerminalResourceRegistration,
	workspacePerformance,
} from "@/lib/workspace/performance/workspacePerformance";
import { useStore } from "@/store";
import type { WorkspacePerformanceFixture } from "./fixture";

export interface WorkspacePerformanceStructuredTerminalSurface {
	readonly connected: boolean;
	focus(): Promise<void>;
	observeInput(
		marker: string,
		input: string,
		observers: {
			readonly onReceipt: (receipt: TerminalQaInputReceipt) => void;
			readonly onProjection: (state: TerminalQaBufferState) => void;
		},
	): Promise<StructuredTerminalQaInputObservation>;
	bufferState(logicalMarker?: string): TerminalQaBufferState | undefined;
}

export interface WorkspacePerformanceStructuredTerminalLease {
	surface(
		panelId: string,
	): WorkspacePerformanceStructuredTerminalSurface | undefined;
	dispose(): void;
}

export function createWorkspacePerformanceStructuredTerminalLease(
	fixture: Pick<WorkspacePerformanceFixture, "spaces" | "panelIdsByDesktop">,
): WorkspacePerformanceStructuredTerminalLease {
	const windowLabel = getCurrentWebviewWindow().label;
	const surfaces = new Map<string, StructuredTerminalQaProbe>();
	const releases: Array<() => void> = [];
	let disposed = false;
	for (const desktop of fixture.spaces) {
		for (const panelId of fixture.panelIdsByDesktop[desktop.id] ?? []) {
			const terminalId = hmuxPaneOwnerId(windowLabel, desktop.id, panelId);
			let resource: TerminalResourceRegistration | undefined;
			let hydrating = true;
			let synchronized = false;
			let presentationRevision = 0;
			let settledPresentationRevision = 0;
			let lastError: unknown;
			const readVisibility = () =>
				useStore.getState().activeSpaceId === desktop.id;
			const probe = new StructuredTerminalQaProbe(panelId, {
				onConnected: () => {
					resource?.dispose();
					const registration = workspacePerformance.registerTerminal({
						id: terminalId,
						desktopId: desktop.id,
						panelId,
						runtime: "hmux",
						renderer: "dom",
						gpuViewportBytes: 0,
						visible: readVisibility(),
						readVisibility,
					});
					resource = registration;
					return () => {
						registration.dispose();
						if (resource === registration) resource = undefined;
					};
				},
				onFocused: () => {
					if (resource)
						workspacePerformance.markTerminalInteractive(terminalId);
				},
				onHydrationChange: (next) => {
					hydrating = next;
					if (next) synchronized = false;
				},
				onSynchronized: () => {
					synchronized = true;
					workspacePerformance.markTerminalAttachSynchronized(
						terminalId,
						!readVisibility(),
					);
				},
				onPresented: (state) => {
					presentationRevision += 1;
					resource?.updateVisibility(readVisibility());
					if (!resource || !synchronized || hydrating) return;
					if (
						!state.fitDimensionsMatch ||
						!state.viewportFill.fillsContainer ||
						state.concealed
					) {
						return;
					}
					settledPresentationRevision = presentationRevision;
					workspacePerformance.markTerminalPaint(terminalId);
					workspacePerformance.captureTerminalStable(terminalId, desktop.id)();
				},
				onError: (error) => {
					lastError = error;
				},
			});
			surfaces.set(panelId, probe);
			const expected = workspacePerformance.registerExpectedTerminal({
				id: terminalId,
				desktopId: desktop.id,
				panelId,
				visible: readVisibility(),
				readVisibility,
			});
			const unregisterDiagnostic = registerTerminalStableDiagnostic({
				id: terminalId,
				desktopId: desktop.id,
				panelId,
				readState: () => ({
					disposed,
					onScreen: probe.connected && readVisibility(),
					rehydrating: hydrating || !synchronized,
					retainedRevealPending: false,
					rendererActivationPending: false,
					rendererPromotionRequired: false,
					geometryPolicyPending: false,
					geometryRevision: presentationRevision,
					settledGeometryRevision: settledPresentationRevision,
					hydratingClass: false,
					fitSettlingClass: false,
					canonicalResizeSettlingClass: false,
				}),
				readDetails: () => ({
					renderer: "structured_dom",
					presentationActive: readVisibility(),
					bufferState: probe.bufferState(),
					...(lastError === undefined
						? {}
						: {
								error:
									lastError instanceof Error
										? lastError.message
										: String(lastError),
							}),
				}),
			});
			const unregisterProbe = registerTerminalWindowFocusProbe(
				terminalId,
				probe,
			);
			releases.push(() => {
				unregisterProbe();
				probe.dispose();
				unregisterDiagnostic();
				expected.dispose();
			});
		}
	}
	return {
		surface: (panelId) => surfaces.get(panelId),
		dispose: () => {
			if (disposed) return;
			disposed = true;
			for (const release of releases.splice(0).reverse()) release();
			surfaces.clear();
		},
	};
}
