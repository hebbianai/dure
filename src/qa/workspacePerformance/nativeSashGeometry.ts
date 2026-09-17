import { collectTerminalGeometryDiagnostics } from "@/lib/terminal/geometry/terminalGeometryDiagnostics";
import { assertBackgroundResizeDelivery } from "./backgroundResizeDelivery";
import { assertDockviewContainerResize } from "./dockviewContainerResize";
import type { WorkspacePerformanceFixture } from "./fixture";
import { assertHiddenBranchLayout } from "./hiddenBranchLayout";
import { summarizeWorkspacePerformanceSashGeometry } from "./sashGeometry";
import { installWorkspacePerformanceSashSelectionProbe } from "./sashSelection";
import type { WorkspacePerformanceStructuredTerminalLease } from "./structuredTerminalSurface";

interface NativeSashGeometryOptions {
	readonly fixture: WorkspacePerformanceFixture;
	readonly terminalSurfaces: WorkspacePerformanceStructuredTerminalLease;
	readonly setQaStatus: (
		state: "running" | "complete" | "failed",
		phase: string,
	) => void;
	readonly waitFor: (
		description: string,
		predicate: () => boolean,
	) => Promise<void>;
	readonly assertTerminalViewportFill: (panelIds: string[] | undefined) => void;
}

/** Runs the real-input-only sash phase without growing the workload runner. */
export async function runNativeSashGeometry({
	fixture,
	terminalSurfaces,
	setQaStatus,
	waitFor,
	assertTerminalViewportFill,
}: NativeSashGeometryOptions): Promise<void> {
	assertHiddenBranchLayout(document);
	await assertDockviewContainerResize(document);
	await assertBackgroundResizeDelivery(fixture, terminalSurfaces, waitFor);
	const before = collectTerminalGeometryDiagnostics(document);
	const sash = [...document.querySelectorAll<HTMLElement>(".dv-sash")].find(
		(candidate) => {
			const bounds = candidate.getBoundingClientRect();
			return bounds.height > 100 && bounds.height > bounds.width;
		},
	);
	if (!sash) throw new Error("native terminal sash target is missing");
	const sashBounds = sash.getBoundingClientRect();
	const selectionProbe = installWorkspacePerformanceSashSelectionProbe(
		document,
		sash,
		sashBounds,
	);
	let evidence = summarizeWorkspacePerformanceSashGeometry(before, before);
	try {
		setQaStatus("running", "sash_ready");
		const ready = window.__DURE_WORKSPACE_PERFORMANCE_QA__;
		if (!ready) throw new Error("workspace performance QA status is missing");
		window.__DURE_WORKSPACE_PERFORMANCE_QA__ = {
			...ready,
			sashSelection: selectionProbe.evidence(),
			sashTarget: {
				x: sashBounds.left + sashBounds.width / 2,
				y: sashBounds.top + sashBounds.height * 0.58,
			},
		};
		await waitFor(
			"two native sash transitions and terminal geometry convergence",
			() => {
				evidence = summarizeWorkspacePerformanceSashGeometry(
					before,
					collectTerminalGeometryDiagnostics(document),
				);
				return evidence.converged;
			},
		);
		await waitFor("native sash stable terminal diagnostics", () => {
			try {
				assertTerminalViewportFill(
					fixture.panelIdsByDesktop[fixture.activeSpaceId],
				);
				return true;
			} catch {
				return false;
			}
		});
		const current = window.__DURE_WORKSPACE_PERFORMANCE_QA__;
		if (!current) throw new Error("workspace performance QA status is missing");
		window.__DURE_WORKSPACE_PERFORMANCE_QA__ = {
			...current,
			sashResize: evidence,
			sashSelection: selectionProbe.evidence(),
		};
	} finally {
		selectionProbe.dispose();
	}
}
