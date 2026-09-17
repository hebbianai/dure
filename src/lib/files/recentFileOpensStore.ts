// 최근 연 파일 — 메인 스토어와 분리된 전용 persisted store
// (fileTreeExpansionStore 패턴). pane 포커스와 무관하게 파일 사이드 패널에
// 항상 보이는 목록의 원천이다. 판정은 lib/recentFileOpens 순수 모듈.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import {
	normalizeRecentFileOpens,
	pushRecentFileOpen,
	type RecentFileOpen,
} from "@/lib/files/recentFileOpens";

interface RecentFileOpensStore {
	entries: RecentFileOpen[];
	record: (entry: Omit<RecentFileOpen, "at">) => void;
}

export const useRecentFileOpens = create<RecentFileOpensStore>()(
	persist(
		(set) => ({
			entries: [],
			record: (entry) =>
				set((state) => ({
					entries: pushRecentFileOpen(state.entries, {
						...entry,
						at: Date.now(),
					}),
				})),
		}),
		{
			name: "agent-ide-recent-file-opens",
			version: 1,
			storage: createReferenceAwareLocalStorage(),
			partialize: (state) => ({ entries: state.entries }),
			merge: (persisted, current) => ({
				...current,
				entries: normalizeRecentFileOpens(
					(persisted as { entries?: unknown } | undefined)?.entries,
				),
			}),
		},
	),
);

/** 뷰어 열기 관문(dock)에서 부르는 기록 훅 — 컴포넌트 밖에서도 안전. */
export function recordRecentFileOpen(entry: Omit<RecentFileOpen, "at">): void {
	useRecentFileOpens.getState().record(entry);
}
