// 숨긴 파일 뷰어 pane 기록 — 전용 persisted store(hiddenPanesStore와 같은
// 패턴). 파일 pane은 세션이 없어 평소에는 Spaces에 표시하지 않지만(사용자
// 확인 2026-08-01), 숨기면 복귀 표면이 필요하므로 그때만 hidden 행으로
// 나타난다. 기록 해제는 파일 뷰어 열기 단일 관문(fileViewerPane)이 한다.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type FileTarget, fileTargetFromParams } from "@/lib/files/fileTarget";
import {
	type HiddenPaneAnchor,
	normalizeHiddenPaneAnchor,
} from "@/lib/workspace/pane/hiddenPanesStore";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";

export interface HiddenFilePaneRecord {
	desktopId: string;
	at: number;
	file: Omit<FileTarget, "sessionId">;
	anchor?: HiddenPaneAnchor;
}

interface HiddenFilePanesStore {
	/** Stable pane ID to hidden placement and document coordinates. */
	hidden: Record<string, HiddenFilePaneRecord>;
	markHidden: (
		panelId: string,
		record: Omit<HiddenFilePaneRecord, "at">,
	) => void;
	clearHidden: (panelId: string) => void;
}

export function normalizeHiddenFilePanes(
	value: unknown,
): Record<string, HiddenFilePaneRecord> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const entries: [string, HiddenFilePaneRecord][] = [];
	for (const [panelId, raw] of Object.entries(value)) {
		if (!panelId) continue;
		if (typeof raw !== "object" || raw === null) continue;
		const record = raw as Record<string, unknown>;
		if (typeof record.desktopId !== "string" || !record.desktopId) continue;
		if (typeof record.at !== "number" || !Number.isFinite(record.at)) continue;
		const target = fileTargetFromParams(record.file);
		if (!target) continue;
		const { sessionId: _sessionId, ...file } = target;
		const anchor = normalizeHiddenPaneAnchor(record.anchor);
		entries.push([panelId, {
			desktopId: record.desktopId,
			at: record.at,
			file,
			...(anchor ? { anchor } : {}),
		}]);
	}
	return Object.fromEntries(entries);
}

export const useHiddenFilePanes = create<HiddenFilePanesStore>()(
	persist(
		(set) => ({
			hidden: {},
			markHidden: (panelId, record) =>
				set((state) => ({
					hidden: { ...state.hidden, [panelId]: { ...record, at: Date.now() } },
				})),
			clearHidden: (panelId) =>
				set((state) => {
					if (!(panelId in state.hidden)) return {};
					const { [panelId]: _removed, ...rest } = state.hidden;
					return { hidden: rest };
				}),
		}),
		{
			name: "agent-ide-hidden-file-panes",
			version: 1,
			storage: createReferenceAwareLocalStorage(),
			partialize: (state) => ({ hidden: state.hidden }),
			merge: (persisted, current) => ({
				...current,
				hidden: normalizeHiddenFilePanes(
					(persisted as { hidden?: unknown } | undefined)?.hidden,
				),
			}),
		},
	),
);

export function markFilePaneHidden(
	panelId: string,
	record: Omit<HiddenFilePaneRecord, "at">,
): void {
	useHiddenFilePanes.getState().markHidden(panelId, record);
}

export function clearFilePaneHidden(panelId: string): void {
	useHiddenFilePanes.getState().clearHidden(panelId);
}
