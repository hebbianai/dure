import { fnv1a32 } from "@/lib/platform/hash";
import {
	ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
	type OnboardingImportDesktopDraft,
	type OnboardingImportDraft,
	type OnboardingImportPaneDraft,
} from "@/lib/onboarding/onboardingImportDraft";
import type { OnboardingImportScope } from "@/lib/onboarding/onboardingImportSelection";

function onboardingImportPaneSourceKey(
	pane: Pick<OnboardingImportPaneDraft, "executionLocation" | "hostId">,
): string {
	return pane.executionLocation === "local"
		? "local"
		: `ssh:${pane.hostId ?? "unknown"}`;
}

/** base36 형식은 이 모듈의 영속 id 계약 — 알고리즘만 공유 코어에 위임. */
function stableHash(value: string): string {
	return fnv1a32(value).toString(36);
}

function freshDesktopForPane(
	incoming: OnboardingImportDraft,
	paneKey: string,
): OnboardingImportDesktopDraft | undefined {
	return incoming.desktops.find((desktop) =>
		desktop.panes.some((pane) => pane.key === paneKey),
	);
}

function appendNewPane(
	desktops: OnboardingImportDesktopDraft[],
	incoming: OnboardingImportDraft,
	pane: OnboardingImportPaneDraft,
	scope: OnboardingImportScope,
): void {
	const scopedPane = scope === "all" ? { ...pane, selected: true } : pane;
	for (let index = desktops.length - 1; index >= 0; index -= 1) {
		const desktop = desktops[index];
		if (
			desktop.sourceGroupIdentity === pane.groupIdentity &&
			desktop.panes.length < ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT
		) {
			desktops[index] = { ...desktop, panes: [...desktop.panes, scopedPane] };
			return;
		}
	}

	const proposed = freshDesktopForPane(incoming, pane.key);
	const groupDesktopIndexes = desktops.flatMap((desktop, index) =>
		desktop.sourceGroupIdentity === pane.groupIdentity ? [index] : [],
	);
	const usedIds = new Set(desktops.map((desktop) => desktop.id));
	let id = proposed?.id ?? `import-refresh-${stableHash(pane.key)}`;
	let suffix = 2;
	while (usedIds.has(id)) {
		id = `import-refresh-${stableHash(pane.key)}-${suffix}`;
		suffix += 1;
	}
	const sourceGroupName =
		proposed?.sourceGroupName?.trim() || proposed?.name.trim() || "Desktop";
	const desktop: OnboardingImportDesktopDraft = {
		id,
		sourceGroupIdentity: pane.groupIdentity,
		sourceGroupName,
		name:
			groupDesktopIndexes.length === 0
				? (proposed?.name ?? sourceGroupName)
				: `${sourceGroupName} ${groupDesktopIndexes.length + 1}`,
		included: proposed?.included ?? true,
		panes: [scopedPane],
	};
	const insertionIndex =
		groupDesktopIndexes.length === 0
			? desktops.length
			: groupDesktopIndexes[groupDesktopIndexes.length - 1] + 1;
	desktops.splice(insertionIndex, 0, desktop);
}

/** Merge a partial progressive scan into the user's current draft. Only a
 * source that completed successfully is authoritative for removals. Existing
 * pane placement and presentation edits stay authoritative; refreshed source
 * metadata and newly discovered conversations are merged around them. */
export function reconcileOnboardingImportDraft(
	current: OnboardingImportDraft | undefined,
	incoming: OnboardingImportDraft,
	authoritativeSourceKeys: readonly string[],
	scope: OnboardingImportScope,
): OnboardingImportDraft {
	if (!current) return incoming;

	const authoritative = new Set(authoritativeSourceKeys);
	const incomingByKey = new Map(
		incoming.desktops.flatMap((desktop) =>
			desktop.panes.map((pane) => [pane.key, pane] as const),
		),
	);
	const desktops = current.desktops.map((desktop) => ({
		...desktop,
		panes: desktop.panes.flatMap((pane) => {
			const refreshed = incomingByKey.get(pane.key);
			if (refreshed) return [{ ...refreshed, selected: pane.selected }];
			return authoritative.has(onboardingImportPaneSourceKey(pane))
				? []
				: [pane];
		}),
	}));
	const placedKeys = new Set(
		desktops.flatMap((desktop) => desktop.panes.map((pane) => pane.key)),
	);
	for (const incomingDesktop of incoming.desktops) {
		for (const pane of incomingDesktop.panes) {
			if (placedKeys.has(pane.key)) continue;
			appendNewPane(desktops, incoming, pane, scope);
			placedKeys.add(pane.key);
		}
	}

	return {
		desktops,
		discoveredCount: desktops.reduce(
			(total, desktop) => total + desktop.panes.length,
			0,
		),
	};
}
