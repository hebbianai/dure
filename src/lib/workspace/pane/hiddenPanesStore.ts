// 숨긴 pane 기록 — 전용 persisted store. 숨긴 에이전트는 "안 연 에이전트"로
// 강등되지 않고(사용자 지적 2026-08-01) 원래 데스크탑 그룹 자리에 hidden
// 표시로 남아 클릭 한 번으로 복귀한다. 기록 삭제는 실제 restore 성공 뒤의
// 단일 경로에서만 허용한다. mounted AgentPanel의 visibility 관찰은 Dockview
// 전환 중 stale할 수 있어 삭제 권한으로 쓰지 않는다.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { track } from "@/lib/ipc/telemetry";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";

/** 원래 자리 복원 힌트.
 *  - grid: 이웃 pane과 그 이웃 기준 방향 — 구 저장분/stacked-group 폴백용.
 *    정상 경로는 Dockview group을 숨긴 채 유지해 원래 슬롯을 그대로 되찾는다.
 *  - floating: 숨길 당시의 컨테이너 기준 rect. floating group은 hidden 상태가
 *    직렬화에서 크기 0·visible로 깨지므로(실측 2026-08-01) 제거 후 이 rect로
 *    같은 자리에 다시 띄운다. */
export type HiddenPaneAnchor =
	| {
			referencePanelId: string;
			direction: "left" | "right" | "above" | "below";
	  }
	| { floating: { x: number; y: number; width: number; height: number } };

export interface HiddenPaneRecord {
	paneId: string;
	desktopId: string;
	at: number;
	anchor?: HiddenPaneAnchor;
}

export function normalizeHiddenPaneAnchor(
	value: unknown,
): HiddenPaneAnchor | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as Record<string, unknown>;
	const floating = raw.floating as Record<string, unknown> | undefined;
	if (typeof floating === "object" && floating !== null) {
		const nums = ["x", "y", "width", "height"].map((k) => floating[k]);
		if (nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
			const [x, y, width, height] = nums as number[];
			return { floating: { x, y, width, height } };
		}
		return undefined;
	}
	if (typeof raw.referencePanelId !== "string" || !raw.referencePanelId)
		return undefined;
	if (
		raw.direction !== "left" &&
		raw.direction !== "right" &&
		raw.direction !== "above" &&
		raw.direction !== "below"
	) {
		return undefined;
	}
	return { referencePanelId: raw.referencePanelId, direction: raw.direction };
}

interface HiddenPanesStore {
	/** agentId → 숨긴 위치. 에이전트 pane만 숨길 수 있다(복귀 표면 보장). */
	hidden: Record<string, HiddenPaneRecord>;
	markHidden: (
		agentId: string,
		desktopId: string,
		paneId: string,
		anchor?: HiddenPaneRecord["anchor"],
	) => void;
	clearHidden: (agentId: string) => void;
}

export function normalizeHiddenPanes(
	value: unknown,
): Record<string, HiddenPaneRecord> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const entries: Record<string, HiddenPaneRecord> = {};
	for (const [agentId, raw] of Object.entries(value)) {
		if (typeof raw !== "object" || raw === null) continue;
		const record = raw as Record<string, unknown>;
		if (typeof record.desktopId !== "string" || !record.desktopId) continue;
		if (typeof record.at !== "number" || !Number.isFinite(record.at)) continue;
		// Only pre-identity records need the historical pane name at ingress.
		const paneId = "paneId" in record ? record.paneId : `agent:${agentId}`;
		if (typeof paneId !== "string" || !paneId) continue;
		const anchor = normalizeHiddenPaneAnchor(record.anchor);
		entries[agentId] = {
			paneId,
			desktopId: record.desktopId,
			at: record.at,
			...(anchor ? { anchor } : {}),
		};
	}
	return entries;
}

export const useHiddenPanes = create<HiddenPanesStore>()(
	persist(
		(set) => ({
			hidden: {},
			markHidden: (agentId, desktopId, paneId, anchor) =>
				set((state) => ({
					hidden: {
						...state.hidden,
						[agentId]: {
							paneId,
							desktopId,
							at: Date.now(),
							...(anchor ? { anchor } : {}),
						},
					},
				})),
			clearHidden: (agentId) =>
				set((state) => {
					if (!(agentId in state.hidden)) return {};
					const { [agentId]: _removed, ...rest } = state.hidden;
					return { hidden: rest };
				}),
		}),
		{
			name: "agent-ide-hidden-panes",
			version: 1,
			storage: createReferenceAwareLocalStorage(),
			partialize: (state) => ({ hidden: state.hidden }),
			merge: (persisted, current) => ({
				...current,
				hidden: normalizeHiddenPanes(
					(persisted as { hidden?: unknown } | undefined)?.hidden,
				),
			}),
		},
	),
);

export function markPaneHidden(
	agentId: string,
	desktopId: string,
	paneId: string,
	anchor?: HiddenPaneRecord["anchor"],
): void {
	useHiddenPanes.getState().markHidden(agentId, desktopId, paneId, anchor);
}

export function clearPaneHiddenAfterRestore(agentId: string): void {
	track("pane_restored");
	useHiddenPanes.getState().clearHidden(agentId);
}
