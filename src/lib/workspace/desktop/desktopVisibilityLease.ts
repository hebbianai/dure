export const DESKTOP_VISIBILITY_LEASE_TTL_MS = 7_000;
const DESKTOP_VISIBILITY_LEASE_PREFIX =
	"agent-ide:desktop-visibility-lease:v1:";
const IDENTITY_LIMIT = 512;

export interface DesktopVisibilityLease {
	schemaVersion: 1;
	windowLabel: string;
	desktopId: string;
	/** Native window visibility: visible and not minimized. */
	visible: boolean;
	updatedAtMs: number;
}

export type DesktopVisibilityLeaseAssessment =
	| {
			complete: true;
			visibleDesktopIds: ReadonlySet<string>;
	  }
	| {
			complete: false;
			reason:
				| "no_workspace_windows"
				| "missing_window_lease"
				| "stale_window_lease";
	  };

function validIdentity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= IDENTITY_LIMIT
	);
}

/** The main/full desktop and popout roots render workspace panes. Diff and
 * source-control utility windows do not own a visible desktop. */
export function isDesktopWorkspaceWindowLabel(label: string): boolean {
	return (
		label === "main" ||
		/^win-\d+-\d+$/.test(label) ||
		label.startsWith("win-popout-")
	);
}

export function desktopVisibilityLeaseStorageKey(windowLabel: string): string {
	return `${DESKTOP_VISIBILITY_LEASE_PREFIX}${windowLabel}`;
}

export function parseDesktopVisibilityLease(
	raw: string | null,
): DesktopVisibilityLease | undefined {
	if (!raw) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return undefined;
		}
		const candidate = value as Partial<DesktopVisibilityLease>;
		if (
			candidate.schemaVersion !== 1 ||
			!validIdentity(candidate.windowLabel) ||
			!validIdentity(candidate.desktopId) ||
			typeof candidate.visible !== "boolean" ||
			typeof candidate.updatedAtMs !== "number" ||
			!Number.isFinite(candidate.updatedAtMs) ||
			candidate.updatedAtMs < 0
		) {
			return undefined;
		}
		return {
			schemaVersion: 1,
			windowLabel: candidate.windowLabel,
			desktopId: candidate.desktopId,
			visible: candidate.visible,
			updatedAtMs: candidate.updatedAtMs,
		};
	} catch {
		return undefined;
	}
}

export function writeDesktopVisibilityLease(
	lease: DesktopVisibilityLease,
): boolean {
	if (
		parseDesktopVisibilityLease(JSON.stringify(lease)) === undefined ||
		!isDesktopWorkspaceWindowLabel(lease.windowLabel)
	) {
		return false;
	}
	try {
		localStorage.setItem(
			desktopVisibilityLeaseStorageKey(lease.windowLabel),
			JSON.stringify(lease),
		);
		return true;
	} catch {
		return false;
	}
}

export function readDesktopVisibilityLease(
	windowLabel: string,
): DesktopVisibilityLease | undefined {
	try {
		const lease = parseDesktopVisibilityLease(
			localStorage.getItem(desktopVisibilityLeaseStorageKey(windowLabel)),
		);
		return lease?.windowLabel === windowLabel ? lease : undefined;
	} catch {
		return undefined;
	}
}

export function removeDesktopVisibilityLease(windowLabel: string): void {
	try {
		localStorage.removeItem(desktopVisibilityLeaseStorageKey(windowLabel));
	} catch {
		// A stale record cannot authorize work: the live-window census still
		// requires a fresh matching lease and fails closed after the TTL.
	}
}

export function assessDesktopVisibilityLeases(
	windowLabels: readonly string[],
	nowMs: number,
	nativeVisibleWindowLabels?: ReadonlySet<string>,
): DesktopVisibilityLeaseAssessment {
	const workspaceLabels = [
		...new Set(windowLabels.filter(isDesktopWorkspaceWindowLabel)),
	];
	if (workspaceLabels.length === 0) {
		return { complete: false, reason: "no_workspace_windows" };
	}
	const visibleDesktopIds = new Set<string>();
	for (const label of workspaceLabels) {
		const nativelyVisible = nativeVisibleWindowLabels?.has(label) === true;
		const lease = readDesktopVisibilityLease(label);
		if (!lease) {
			// A native-hidden window cannot authorize recovery. Its missing
			// publisher must not block an independently visible desktop.
			if (nativeVisibleWindowLabels !== undefined && !nativelyVisible) {
				continue;
			}
			return { complete: false, reason: "missing_window_lease" };
		}
		if (
			lease.updatedAtMs > nowMs ||
			nowMs - lease.updatedAtMs > DESKTOP_VISIBILITY_LEASE_TTL_MS
		) {
			if (nativeVisibleWindowLabels !== undefined && !nativelyVisible) {
				continue;
			}
			return { complete: false, reason: "stale_window_lease" };
		}
		// Disagreement is always protection. A publisher can lag a native
		// restore, and a native query can lag a publisher's desktop switch.
		if (lease.visible || nativelyVisible) {
			visibleDesktopIds.add(lease.desktopId);
		}
	}
	return { complete: true, visibleDesktopIds };
}
