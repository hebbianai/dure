import { schedulePostPaint } from "@/lib/scheduling/postPaint";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import type { WorkspacePerformanceFixture } from "./fixture";

interface WorkspacePerformanceSurfaceCleanupHost {
	dockview: typeof getDockview;
	postPaint(): Promise<void>;
}

export class WorkspacePerformanceSurfaceCleanupError extends Error {
	constructor(readonly errors: readonly unknown[]) {
		super(`workspace performance surface cleanup failed (${errors.length})`);
		this.name = "WorkspacePerformanceSurfaceCleanupError";
	}
}

const browserHost: WorkspacePerformanceSurfaceCleanupHost = {
	dockview: getDockview,
	postPaint: () =>
		new Promise<void>((resolve) => schedulePostPaint(window, resolve)),
};

/** Detaches every observer before the isolated Host sessions are stopped. */
export async function detachWorkspacePerformanceSurfaces(
	fixture: WorkspacePerformanceFixture,
	host: WorkspacePerformanceSurfaceCleanupHost = browserHost,
): Promise<void> {
	const errors: unknown[] = [];
	for (const desktop of fixture.spaces) {
		const dockview = host.dockview(desktop.id);
		if (!dockview) continue;
		for (const panelId of fixture.panelIdsByDesktop[desktop.id] ?? []) {
			const panel = dockview.getPanel(panelId);
			if (!panel) continue;
			try {
				dockview.removePanel(panel);
			} catch (error) {
				errors.push(error);
			}
		}
	}
	try {
		await host.postPaint();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) {
		throw new WorkspacePerformanceSurfaceCleanupError(errors);
	}
}
