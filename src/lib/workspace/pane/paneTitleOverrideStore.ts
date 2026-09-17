import type { DockviewPanelApi } from "dockview-react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";

const MAX_PANE_TITLE_LENGTH = 120;

export interface PaneTitleOverride {
	title: string;
	fallback: string;
}

interface PaneTitleOverrideStore {
	overrides: Record<string, PaneTitleOverride>;
	setOverride: (panelId: string, title: string, fallback: string) => void;
	rememberFallback: (panelId: string, fallback: string) => void;
	clearOverride: (panelId: string) => void;
}

function cleanTitle(value: unknown): string {
	return typeof value === "string"
		? value.trim().slice(0, MAX_PANE_TITLE_LENGTH)
		: "";
}

export function normalizePaneTitleOverrides(
	value: unknown,
): Record<string, PaneTitleOverride> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const normalized: Record<string, PaneTitleOverride> = {};
	for (const [panelId, raw] of Object.entries(value)) {
		if (!panelId || typeof raw !== "object" || raw === null) continue;
		const record = raw as Record<string, unknown>;
		const title = cleanTitle(record.title);
		const fallback = cleanTitle(record.fallback);
		if (title && fallback) normalized[panelId] = { title, fallback };
	}
	return normalized;
}

export const usePaneTitleOverrides = create<PaneTitleOverrideStore>()(
	persist(
		(set) => ({
			overrides: {},
			setOverride: (panelId, title, fallback) =>
				set((state) => {
					const cleanedTitle = cleanTitle(title);
					const cleanedFallback =
						state.overrides[panelId]?.fallback ?? cleanTitle(fallback) ?? panelId;
					if (!cleanedTitle) {
						const { [panelId]: _removed, ...rest } = state.overrides;
						return { overrides: rest };
					}
					return {
						overrides: {
							...state.overrides,
							[panelId]: {
								title: cleanedTitle,
								fallback: cleanedFallback || panelId,
							},
						},
					};
				}),
			rememberFallback: (panelId, fallback) =>
				set((state) => {
					const current = state.overrides[panelId];
					const cleaned = cleanTitle(fallback);
					if (!current || !cleaned || current.fallback === cleaned) return {};
					return {
						overrides: {
							...state.overrides,
							[panelId]: { ...current, fallback: cleaned },
						},
					};
				}),
			clearOverride: (panelId) =>
				set((state) => {
					if (!(panelId in state.overrides)) return {};
					const { [panelId]: _removed, ...rest } = state.overrides;
					return { overrides: rest };
				}),
		}),
		{
			name: "agent-ide-pane-title-overrides",
			version: 1,
			storage: createReferenceAwareLocalStorage(),
			partialize: (state) => ({ overrides: state.overrides }),
			merge: (persisted, current) => ({
				...current,
				overrides: normalizePaneTitleOverrides(
					(persisted as { overrides?: unknown } | undefined)?.overrides,
				),
			}),
		},
	),
);

type TitledPanelApi = Pick<DockviewPanelApi, "id" | "setTitle"> & {
	title?: string;
};

/** 동적 cwd/file 제목을 기억하되, 사용자 제목이 있으면 그것을 계속 적용한다. */
export function applyAutomaticPaneTitle(
	api: TitledPanelApi,
	automaticTitle: string,
): void {
	const title = cleanTitle(automaticTitle) || api.id;
	const state = usePaneTitleOverrides.getState();
	const override = state.overrides[api.id];
	if (override) {
		state.rememberFallback(api.id, title);
		api.setTitle(override.title);
		return;
	}
	api.setTitle(title);
}

export function renamePaneTitle(api: TitledPanelApi, value: string): void {
	const state = usePaneTitleOverrides.getState();
	const current = state.overrides[api.id];
	const title = cleanTitle(value);
	if (!title) {
		state.clearOverride(api.id);
		api.setTitle(current?.fallback || api.title || api.id);
		return;
	}
	state.setOverride(api.id, title, current?.fallback || api.title || api.id);
	api.setTitle(title);
}
