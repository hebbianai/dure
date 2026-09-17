import { getFrameBudgetScheduler } from "@/lib/scheduling/frameBudgetScheduler";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import type { WorkspacePerformanceFixture } from "./fixture";
import type { WorkspacePerformanceStructuredTerminalLease } from "./structuredTerminalSurface";

/** Exercise the mounted Hmux terminal, not a second synthetic reader. Keep
 * ordinary painting paused while a real provider echo precedes a resize.
 */
export async function assertBackgroundResizeDelivery(
	fixture: WorkspacePerformanceFixture,
	surfaces: WorkspacePerformanceStructuredTerminalLease,
	waitFor: (description: string, predicate: () => boolean) => Promise<void>,
): Promise<void> {
	const panelId = fixture.panelIdsByDesktop[fixture.activeSpaceId]?.[1];
	if (!panelId) throw new Error("background resize QA needs two terminals");
	const api = getDockview(fixture.activeSpaceId);
	const panel = api?.getPanel(panelId);
	const surface = surfaces.surface(panelId);
	const host = panel?.group.element.querySelector<HTMLElement>(
		".structured-terminal-host",
	);
	if (!panel || !surface || !host || api?.activePanel?.id === panelId) {
		throw new Error("background resize QA needs a mounted, inactive terminal");
	}
	const initial = surface.bufferState();
	if (!initial?.fitDimensionsMatch)
		throw new Error("background resize QA seed is not fitted");
	const scheduler = getFrameBudgetScheduler();
	const paints = () =>
		scheduler.getTelemetry().catchup.sources[
			"structured-terminal-presentation.background"
		];
	await waitFor(
		"background terminal paint quiescence",
		() => !paints()?.pending,
	);
	const committedBefore = paints()?.unitsRun ?? 0;
	const previousWidth = host.style.width;
	let frame = 0;
	const holdPaint = () => {
		scheduler.notifyInteraction("input");
		frame = requestAnimationFrame(holdPaint);
	};
	holdPaint();
	let received = false;
	let failure: unknown;
	const marker = `resize-delivery-${Date.now()}`;
	const observation = surface
		.observeInput(marker, marker, {
			onReceipt: () => {
				received = true;
			},
			onProjection: () => {},
		})
		.catch((error) => {
			failure = error;
		});
	try {
		await waitFor("provider output waiting for background paint", () => {
			if (failure) throw failure;
			return received && (paints()?.pending ?? 0) > 0;
		});
		host.style.width = `${Math.max(100, host.clientWidth - 80)}px`;
		await waitFor("resize completion ahead of background painting", () => {
			if (failure) throw failure;
			if ((paints()?.unitsRun ?? 0) !== committedBefore) {
				throw new Error(
					"resize completion waited for background paint admission",
				);
			}
			const state = surface.bufferState();
			return (
				state !== undefined &&
				state.columns !== initial.columns &&
				state.fitDimensionsMatch === true &&
				state.viewportFill.fillsContainer
			);
		});
		await observation;
		if (failure) throw failure;
	} finally {
		cancelAnimationFrame(frame);
		host.style.width = previousWidth;
	}
	await waitFor("background resize QA geometry restored", () => {
		const state = surface.bufferState();
		return (
			state?.columns === initial.columns && state.fitDimensionsMatch === true
		);
	});
}
