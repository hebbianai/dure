import { fnv1a32 } from "@/lib/platform/hash";
import type { Provider } from "@/types";

export const ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT = 8;
const ONBOARDING_IMPORT_VISIBLE_PANE_LIMIT = 8;

interface OnboardingImportProjectionItem {
	key: string;
	conversationId: string;
	title: string;
	mtime: number;
	provider: Provider;
	cwd: string;
	workspaceRoot: string;
	groupIdentity: string;
	defaultSelected: boolean;
	recencyBucket?: "recent" | "older";
	executionLocation: "local" | "ssh";
	hostId?: string;
	repositoryCommonDir?: string;
	repositoryRemoteIdentity?: string;
}

interface OnboardingImportProjectionGroup {
	id: string;
	name: string;
	cwd: string;
	items: readonly OnboardingImportProjectionItem[];
}

export interface OnboardingImportProjection {
	total: number;
	groups: readonly OnboardingImportProjectionGroup[];
}

export interface OnboardingImportPaneDraft
	extends OnboardingImportProjectionItem {
	selected: boolean;
}

export interface OnboardingImportDesktopDraft {
	id: string;
	sourceGroupIdentity: string;
	sourceGroupName?: string;
	name: string;
	included: boolean;
	panes: readonly OnboardingImportPaneDraft[];
}

export interface OnboardingImportDraft {
	desktops: readonly OnboardingImportDesktopDraft[];
	discoveredCount: number;
}

type OnboardingImportLayoutKind =
	| "empty"
	| "single"
	| "split"
	| "grid"
	| "grid_tabs";

export interface OnboardingImportLayoutRecommendation {
	kind: OnboardingImportLayoutKind;
	visiblePaneCount: number;
	tabbedPaneCount: number;
}

interface OnboardingImportLayoutCell {
	paneKey: string;
	row: number;
	column: number;
	rowSpan: number;
	columnSpan: number;
}

export interface OnboardingImportLayoutPlan {
	columns: number;
	rows: number;
	cells: readonly OnboardingImportLayoutCell[];
	tabbedPaneKeys: readonly string[];
}

type OnboardingImportDraftMutationError =
	| "desktop_pane_limit"
	| "desktop_not_found"
	| "pane_not_found"
	| "invalid_split";

export interface OnboardingImportDraftMutation {
	draft: OnboardingImportDraft;
	error?: OnboardingImportDraftMutationError;
}

/** base36 형식은 이 모듈의 영속 id 계약 — 알고리즘만 공유 코어에 위임. */
function stableHash(value: string): string {
	return fnv1a32(value).toString(36);
}

function desktopId(
	groupIdentity: string,
	chunkIndex: number,
	items: readonly OnboardingImportProjectionItem[],
): string {
	return `import-${stableHash(
		`${groupIdentity}\0${chunkIndex}\0${items.map((item) => item.key).join("\0")}`,
	)}`;
}

function selectedPaneCount(desktop: OnboardingImportDesktopDraft): number {
	return desktop.panes.filter((pane) => pane.selected).length;
}

function replaceDesktop(
	draft: OnboardingImportDraft,
	desktopId: string,
	replace: (desktop: OnboardingImportDesktopDraft) => OnboardingImportDesktopDraft,
): OnboardingImportDraft {
	return {
		...draft,
		desktops: draft.desktops.map((desktop) =>
			desktop.id === desktopId ? replace(desktop) : desktop,
		),
	};
}

export function addOnboardingImportDesktop(
	draft: OnboardingImportDraft,
): OnboardingImportDraftMutation {
	const usedIds = new Set(draft.desktops.map((desktop) => desktop.id));
	let index = 1;
	while (usedIds.has(`import-custom-${index}`)) index += 1;
	return {
		draft: {
			...draft,
			desktops: [
				...draft.desktops,
				{
					id: `import-custom-${index}`,
					sourceGroupIdentity: `custom-${index}`,
					sourceGroupName: `Desktop ${index}`,
					name: `Desktop ${index}`,
					included: true,
					panes: [],
				},
			],
		},
	};
}

export function buildOnboardingImportDraft(
	projection: OnboardingImportProjection,
): OnboardingImportDraft {
	const desktops = projection.groups.flatMap((group) => {
		const sorted = [...group.items].sort(
			(left, right) => right.mtime - left.mtime || left.key.localeCompare(right.key),
		);
		const chunks: OnboardingImportProjectionItem[][] = [];
		for (
			let index = 0;
			index < sorted.length;
			index += ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT
		) {
			chunks.push(sorted.slice(index, index + ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT));
		}
		return chunks.map((items, chunkIndex) => ({
			id: desktopId(group.id, chunkIndex, items),
			sourceGroupIdentity: group.id,
			sourceGroupName: group.name,
			name:
				chunks.length === 1 ? group.name : `${group.name} ${chunkIndex + 1}`,
			included: true,
			panes: items.map((item) => ({ ...item, selected: item.defaultSelected })),
		}));
	});

	return { desktops, discoveredCount: projection.total };
}

export function onboardingImportLayout(
	desktop: OnboardingImportDesktopDraft,
): OnboardingImportLayoutRecommendation {
	const count = selectedPaneCount(desktop);
	if (count === 0) return { kind: "empty", visiblePaneCount: 0, tabbedPaneCount: 0 };
	if (count === 1) return { kind: "single", visiblePaneCount: 1, tabbedPaneCount: 0 };
	if (count === 2) return { kind: "split", visiblePaneCount: 2, tabbedPaneCount: 0 };
	if (count <= ONBOARDING_IMPORT_VISIBLE_PANE_LIMIT) {
		return { kind: "grid", visiblePaneCount: count, tabbedPaneCount: 0 };
	}
	return {
		kind: "grid_tabs",
		visiblePaneCount: ONBOARDING_IMPORT_VISIBLE_PANE_LIMIT,
		tabbedPaneCount: count - ONBOARDING_IMPORT_VISIBLE_PANE_LIMIT,
	};
}

export function onboardingImportLayoutPlan(
	desktop: OnboardingImportDesktopDraft,
): OnboardingImportLayoutPlan {
	const selected = desktop.panes.filter((pane) => pane.selected);
	const visible = selected.slice(0, ONBOARDING_IMPORT_VISIBLE_PANE_LIMIT);
	const tabbedPaneKeys = selected
		.slice(ONBOARDING_IMPORT_VISIBLE_PANE_LIMIT)
		.map((pane) => pane.key);
	if (visible.length === 0) {
		return { columns: 1, rows: 1, cells: [], tabbedPaneKeys };
	}
	if (visible.length === 1) {
		return {
			columns: 1,
			rows: 1,
			cells: [
				{
					paneKey: visible[0].key,
					row: 1,
					column: 1,
					rowSpan: 1,
					columnSpan: 1,
				},
			],
			tabbedPaneKeys,
		};
	}
	if (visible.length === 3) {
		return {
			columns: 3,
			rows: 1,
			cells: visible.map((pane, index) => ({
				paneKey: pane.key,
				row: 1,
				column: index + 1,
				rowSpan: 1,
				columnSpan: 1,
			})),
			tabbedPaneKeys,
		};
	}
	const columns = visible.length <= 4 ? 2 : visible.length <= 6 ? 3 : 4;
	const rows = Math.ceil(visible.length / columns);
	return {
		columns,
		rows,
		cells: visible.map((pane, index) => {
			const row = (index % rows) + 1;
			return {
				paneKey: pane.key,
				row,
				column: Math.floor(index / rows) + 1,
				rowSpan:
					row === 1 && index === visible.length - 1 && visible.length % rows !== 0
						? rows
						: 1,
				columnSpan: 1,
			};
		}),
		tabbedPaneKeys,
	};
}

export function onboardingImportCounts(draft: OnboardingImportDraft): {
	desktopCount: number;
	paneCount: number;
} {
	const included = draft.desktops.filter(
		(desktop) => desktop.included && selectedPaneCount(desktop) > 0,
	);
	return {
		desktopCount: included.length,
		paneCount: included.reduce(
			(total, desktop) => total + selectedPaneCount(desktop),
			0,
		),
	};
}

export function setOnboardingImportDesktopIncluded(
	draft: OnboardingImportDraft,
	desktopId: string,
	included: boolean,
): OnboardingImportDraftMutation {
	if (!draft.desktops.some((desktop) => desktop.id === desktopId)) {
		return { draft, error: "desktop_not_found" };
	}
	return {
		draft: replaceDesktop(draft, desktopId, (desktop) => ({
			...desktop,
			included,
		})),
	};
}

export function renameOnboardingImportDesktop(
	draft: OnboardingImportDraft,
	desktopId: string,
	name: string,
): OnboardingImportDraftMutation {
	if (!draft.desktops.some((desktop) => desktop.id === desktopId)) {
		return { draft, error: "desktop_not_found" };
	}
	return {
		draft: replaceDesktop(draft, desktopId, (desktop) => ({
			...desktop,
			name,
		})),
	};
}

export function setOnboardingImportPaneSelected(
	draft: OnboardingImportDraft,
	desktopId: string,
	paneKey: string,
	selected: boolean,
): OnboardingImportDraftMutation {
	const desktop = draft.desktops.find((candidate) => candidate.id === desktopId);
	if (!desktop) return { draft, error: "desktop_not_found" };
	const pane = desktop.panes.find((candidate) => candidate.key === paneKey);
	if (!pane) return { draft, error: "pane_not_found" };
	if (!pane.selected && selected && selectedPaneCount(desktop) >= ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT) {
		return { draft, error: "desktop_pane_limit" };
	}
	return {
		draft: replaceDesktop(draft, desktopId, (candidate) => ({
			...candidate,
			panes: candidate.panes.map((entry) =>
				entry.key === paneKey ? { ...entry, selected } : entry,
			),
		})),
	};
}

export function moveOnboardingImportPane(
	draft: OnboardingImportDraft,
	paneKey: string,
	fromDesktopId: string,
	toDesktopId: string,
	beforePaneKey?: string,
): OnboardingImportDraftMutation {
	const source = draft.desktops.find((desktop) => desktop.id === fromDesktopId);
	const target = draft.desktops.find((desktop) => desktop.id === toDesktopId);
	if (!source || !target) return { draft, error: "desktop_not_found" };
	const pane = source.panes.find((candidate) => candidate.key === paneKey);
	if (!pane) return { draft, error: "pane_not_found" };
	if (beforePaneKey === paneKey && fromDesktopId === toDesktopId) return { draft };
	if (
		beforePaneKey !== undefined &&
		!target.panes.some((candidate) => candidate.key === beforePaneKey)
	) {
		return { draft, error: "pane_not_found" };
	}
	if (pane.selected && selectedPaneCount(target) >= ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT) {
		if (fromDesktopId !== toDesktopId) {
			return { draft, error: "desktop_pane_limit" };
		}
	}
	const targetWithoutPane = target.panes.filter(
		(candidate) => candidate.key !== paneKey,
	);
	const insertionIndex = beforePaneKey
		? targetWithoutPane.findIndex((candidate) => candidate.key === beforePaneKey)
		: targetWithoutPane.length;
	const targetPanes = [...targetWithoutPane];
	targetPanes.splice(insertionIndex < 0 ? targetPanes.length : insertionIndex, 0, pane);
	return {
		draft: {
			...draft,
			desktops: draft.desktops.map((desktop) => {
				if (source.id === target.id && desktop.id === source.id) {
					return { ...desktop, panes: targetPanes };
				}
				if (desktop.id === source.id) {
					return {
						...desktop,
						panes: desktop.panes.filter((candidate) => candidate.key !== paneKey),
					};
				}
				if (desktop.id === target.id) {
					return { ...desktop, panes: targetPanes };
				}
				return desktop;
			}),
		},
	};
}

export function mergeOnboardingImportDesktops(
	draft: OnboardingImportDraft,
	sourceDesktopId: string,
	targetDesktopId: string,
): OnboardingImportDraftMutation {
	if (sourceDesktopId === targetDesktopId) return { draft };
	const source = draft.desktops.find((desktop) => desktop.id === sourceDesktopId);
	const target = draft.desktops.find((desktop) => desktop.id === targetDesktopId);
	if (!source || !target) return { draft, error: "desktop_not_found" };
	if (
		selectedPaneCount(source) + selectedPaneCount(target) >
		ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT
	) {
		return { draft, error: "desktop_pane_limit" };
	}
	const targetKeys = new Set(target.panes.map((pane) => pane.key));
	return {
		draft: {
			...draft,
			desktops: draft.desktops
				.filter((desktop) => desktop.id !== sourceDesktopId)
				.map((desktop) =>
					desktop.id === targetDesktopId
						? {
								...desktop,
								panes: [
									...desktop.panes,
									...source.panes.filter((pane) => !targetKeys.has(pane.key)),
								],
							}
						: desktop,
				),
		},
	};
}

export function splitOnboardingImportDesktop(
	draft: OnboardingImportDraft,
	sourceDesktopId: string,
	paneKeys: readonly string[],
	name: string,
): OnboardingImportDraftMutation {
	const source = draft.desktops.find((desktop) => desktop.id === sourceDesktopId);
	if (!source) return { draft, error: "desktop_not_found" };
	const selectedKeys = new Set(paneKeys);
	const moved = source.panes.filter((pane) => selectedKeys.has(pane.key));
	if (moved.length === 0 || moved.length === source.panes.length) {
		return { draft, error: "invalid_split" };
	}
	const seed = `${source.id}\0${moved.map((pane) => pane.key).join("\0")}`;
	let nextId = `import-split-${stableHash(seed)}`;
	let suffix = 2;
	while (draft.desktops.some((desktop) => desktop.id === nextId)) {
		nextId = `import-split-${stableHash(seed)}-${suffix}`;
		suffix += 1;
	}
	const sourceIndex = draft.desktops.findIndex(
		(desktop) => desktop.id === sourceDesktopId,
	);
	const nextDesktops = [...draft.desktops];
	nextDesktops[sourceIndex] = {
		...source,
		panes: source.panes.filter((pane) => !selectedKeys.has(pane.key)),
	};
	nextDesktops.splice(sourceIndex + 1, 0, {
		id: nextId,
		sourceGroupIdentity: source.sourceGroupIdentity,
		sourceGroupName: source.sourceGroupName,
		name,
		included: source.included,
		panes: moved,
	});
	return { draft: { ...draft, desktops: nextDesktops } };
}

export function onboardingImportDraftReady(draft: OnboardingImportDraft): boolean {
	return onboardingImportDraftReadyWithinLimit(
		draft,
		ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
	);
}

export type OnboardingImportDraftBlocker =
	| { reason: "no_selection" }
	| { reason: "desktop_name_required"; desktopNumber: number }
	| {
			reason: "desktop_pane_limit";
			desktopName: string;
			selectedPaneCount: number;
			desktopPaneLimit: number;
		};

export function onboardingImportDraftBlocker(
	draft: OnboardingImportDraft,
	desktopPaneLimit: number,
): OnboardingImportDraftBlocker | undefined {
	const selectedDesktops = draft.desktops
		.map((desktop, index) => ({
			desktop,
			desktopNumber: index + 1,
			selectedPaneCount: selectedPaneCount(desktop),
		}))
		.filter(({ desktop, selectedPaneCount: count }) => desktop.included && count > 0);

	if (selectedDesktops.length === 0) return { reason: "no_selection" };

	const unnamed = selectedDesktops.find(
		({ desktop }) => desktop.name.trim().length === 0,
	);
	if (unnamed) {
		return {
			reason: "desktop_name_required",
			desktopNumber: unnamed.desktopNumber,
		};
	}

	const overLimit = selectedDesktops.find(
		({ selectedPaneCount: count }) => count > desktopPaneLimit,
	);
	if (overLimit) {
		return {
			reason: "desktop_pane_limit",
			desktopName: overLimit.desktop.name,
			selectedPaneCount: overLimit.selectedPaneCount,
			desktopPaneLimit,
		};
	}

	return undefined;
}

export function onboardingImportDraftReadyWithinLimit(
	draft: OnboardingImportDraft,
	desktopPaneLimit: number,
): boolean {
	return onboardingImportDraftBlocker(draft, desktopPaneLimit) === undefined;
}
