import type { TerminalPresentationRole } from "@/lib/terminal/presentation/terminalPresentationRoleStore";

export type { TerminalPresentationRole };

interface TerminalPresentationWorkSnapshot {
	commits: number;
	totalMs: number;
	maxMs: number;
}

interface StructuredTerminalPresentationSurfaceSnapshot {
	id: string;
	total: TerminalPresentationWorkSnapshot;
	byRole: Record<TerminalPresentationRole, TerminalPresentationWorkSnapshot>;
}

export interface StructuredTerminalPresentationTotalsSnapshot {
	total: TerminalPresentationWorkSnapshot;
	byRole: Record<TerminalPresentationRole, TerminalPresentationWorkSnapshot>;
}

export interface StructuredTerminalPresentationSnapshot
	extends StructuredTerminalPresentationTotalsSnapshot {
	perSurface: readonly StructuredTerminalPresentationSurfaceSnapshot[];
}

interface MutablePresentationWork {
	commits: number;
	totalMs: number;
	maxMs: number;
}

interface SurfacePresentationWork {
	total: MutablePresentationWork;
	byRole: Record<TerminalPresentationRole, MutablePresentationWork>;
}

const roles: readonly TerminalPresentationRole[] = [
	"foreground",
	"hovered",
	"background",
	"ungated",
];

function emptyWork(): MutablePresentationWork {
	return { commits: 0, totalMs: 0, maxMs: 0 };
}

function emptyByRole(): Record<
	TerminalPresentationRole,
	MutablePresentationWork
> {
	return {
		foreground: emptyWork(),
		hovered: emptyWork(),
		background: emptyWork(),
		ungated: emptyWork(),
	};
}

function emptySurface(): SurfacePresentationWork {
	return { total: emptyWork(), byRole: emptyByRole() };
}

function recordWork(target: MutablePresentationWork, durationMs: number) {
	target.commits += 1;
	target.totalMs += durationMs;
	target.maxMs = Math.max(target.maxMs, durationMs);
}

function snapshotWork(
	work: MutablePresentationWork,
): TerminalPresentationWorkSnapshot {
	return { ...work };
}

function snapshotByRole(
	byRole: Record<TerminalPresentationRole, MutablePresentationWork>,
): Record<TerminalPresentationRole, TerminalPresentationWorkSnapshot> {
	return Object.fromEntries(
		roles.map((role) => [role, snapshotWork(byRole[role])]),
	) as Record<TerminalPresentationRole, TerminalPresentationWorkSnapshot>;
}

export function emptyStructuredTerminalPresentationSnapshot(): StructuredTerminalPresentationSnapshot {
	return {
		total: snapshotWork(emptyWork()),
		byRole: snapshotByRole(emptyByRole()),
		perSurface: [],
	};
}

export function aggregateStructuredTerminalPresentationSnapshots(
	snapshots: readonly StructuredTerminalPresentationSnapshot[],
): StructuredTerminalPresentationTotalsSnapshot {
	const total = emptyWork();
	const byRole = emptyByRole();
	for (const snapshot of snapshots) {
		total.commits += snapshot.total.commits;
		total.totalMs += snapshot.total.totalMs;
		total.maxMs = Math.max(total.maxMs, snapshot.total.maxMs);
		for (const role of roles) {
			byRole[role].commits += snapshot.byRole[role].commits;
			byRole[role].totalMs += snapshot.byRole[role].totalMs;
			byRole[role].maxMs = Math.max(
				byRole[role].maxMs,
				snapshot.byRole[role].maxMs,
			);
		}
	}
	return { total: snapshotWork(total), byRole: snapshotByRole(byRole) };
}

/** Window-local passive accounting for authoritative structured DOM commits. */
export class StructuredTerminalPresentationPerformanceTracker {
	private readonly total = emptyWork();
	private readonly byRole = emptyByRole();
	private readonly surfaces = new Map<string, SurfacePresentationWork>();

	registerSurface(id: string): {
		record(
			role: TerminalPresentationRole,
			timing: {
				readonly projectionStartedAt: number;
				readonly projectionCommittedAt: number;
			},
		): void;
		dispose(): void;
	} {
		const surface = emptySurface();
		this.surfaces.set(id, surface);
		let disposed = false;
		return {
			record: (role, timing) => {
				if (disposed || this.surfaces.get(id) !== surface) return;
				this.recordSurface(surface, role, timing);
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				if (this.surfaces.get(id) === surface) this.surfaces.delete(id);
			},
		};
	}

	private recordSurface(
		surface: SurfacePresentationWork,
		role: TerminalPresentationRole,
		timing: {
			readonly projectionStartedAt: number;
			readonly projectionCommittedAt: number;
		},
	): void {
		const durationMs =
			timing.projectionCommittedAt - timing.projectionStartedAt;
		if (
			!Number.isFinite(timing.projectionStartedAt) ||
			!Number.isFinite(timing.projectionCommittedAt) ||
			timing.projectionStartedAt < 0 ||
			!Number.isFinite(durationMs) ||
			durationMs < 0
		) {
			return;
		}
		recordWork(this.total, durationMs);
		recordWork(this.byRole[role], durationMs);
		recordWork(surface.total, durationMs);
		recordWork(surface.byRole[role], durationMs);
	}

	snapshot(): StructuredTerminalPresentationSnapshot {
		return {
			total: snapshotWork(this.total),
			byRole: snapshotByRole(this.byRole),
			perSurface: Array.from(this.surfaces, ([id, surface]) => ({
				id,
				total: snapshotWork(surface.total),
				byRole: snapshotByRole(surface.byRole),
			})).sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			),
		};
	}
}
