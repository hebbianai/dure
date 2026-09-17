// 관리 세션 서비스들의 공유 컨트롤플레인 관측 소스.
//
// rehost·shell 두 서비스가 같은 5초 주기로 동일 관측(exact session batch + 전체
// 창 isVisible/isMinimized 순회 + 세션 메타데이터 store 쓰기)을 각자 수행해
// 2배의 IPC·store churn을 만들었다(2026-08-04 전수조사). 이 소스는 짧은
// TTL 캐시 + 단일 비행으로 주기 패스들이 한 관측을 공유하게 한다.
//
// 파괴 경계의 재검증(rehost의 assertStillEligible, shell의 promote 재확인)은
// maxAgeMs: 0으로 호출해야 하며, 이때는 캐시·진행 중 fetch를 재사용하지 않고
// 항상 새로 관측한다 — "검사 이후에 표본화된 신선한 exact 조회로 재계산"이라는
// 경계 보증(AGENTS 검토 기준)이 캐시로 약화되면 안 된다.

import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
	exactHmuxSessionTargetKey,
	foundExactHmuxSessions,
	inspectHmuxSessionsExact,
} from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { isHmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import type { HmuxExactSessionTarget, HmuxSessionSummary } from "@/lib/ipc";
import { isTerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import {
	assessDesktopVisibilityLeases,
	isDesktopWorkspaceWindowLabel,
} from "@/lib/workspace/desktop/desktopVisibilityLease";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";

export interface ManagedControlPlaneObservation {
	sessions: HmuxSessionSummary[];
	visibleDesktopIds: ReadonlySet<string>;
}

/** 두 서비스의 5초 틱이 같은 창에서 겹칠 때만 공유되도록 주기의 절반 이하. */
export const MANAGED_OBSERVATION_SHARE_MS = 2_500;

async function fetchObservation() {
	const state = useStore.getState();
	const targets = new Map<string, HmuxExactSessionTarget>();
	for (const agent of state.agents) {
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			continue;
		}
		const target = {
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		};
		targets.set(exactHmuxSessionTargetKey(target), target);
	}
	for (const layout of Object.values(state.layouts)) {
		for (const panel of panelsFromLayout(layout)) {
			if (panel.component !== "terminal") continue;
			const binding = isTerminalPaneBindingV1(panel.params.binding)
				? panel.params.binding
				: undefined;
			if (binding?.source !== "local") {
				continue;
			}
			const localShell = isHmuxProviderSessionSourceBinding(binding, panel.component);
			if (!localShell) continue;
			const target = {
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
			};
			targets.set(exactHmuxSessionTargetKey(target), target);
		}
	}
	const [inspectionResults, windows] = await Promise.all([
		inspectHmuxSessionsExact([...targets.values()]),
		getAllWebviewWindows(),
	]);
	const sessions = foundExactHmuxSessions(inspectionResults);
	// The Host's authoritative runtime state rides on the same inspection.
	// Streamed frames are the fast path; this is the convergence path for a
	// window that missed one (a pane read as waiting through a whole turn,
	// 2026-09-14, #840). The store's revision fence keeps a stale probe from
	// moving anything backwards.
	const runtimeStates = inspectionResults.flatMap((result) =>
		result.outcome === "found" && result.agentRuntimeState
			? [{ sessionId: result.session.sessionId, state: result.agentRuntimeState }]
			: [],
	);
	const workspaceWindows = windows.filter((window) =>
		isDesktopWorkspaceWindowLabel(window.label),
	);
	const nativeVisibility = await Promise.all(
		workspaceWindows.map(async (window) => ({
			label: window.label,
			visible: (await window.isVisible()) && !(await window.isMinimized()),
		})),
	);
	const visibility = assessDesktopVisibilityLeases(
		windows.map((window) => window.label),
		Date.now(),
		new Set(
			nativeVisibility
				.filter((window) => window.visible)
				.map((window) => window.label),
		),
	);
	return { sessions, runtimeStates, visibility };
}

let cached:
	| { atMs: number; value: ManagedControlPlaneObservation | undefined }
	| undefined;
let inFlight: Promise<ManagedControlPlaneObservation | undefined> | undefined;

export async function observeManagedControlPlane(options: {
	maxAgeMs: number;
}): Promise<ManagedControlPlaneObservation | undefined> {
	if (document.visibilityState === "hidden") return undefined;
	const now = Date.now();
	if (options.maxAgeMs > 0 && cached && now - cached.atMs <= options.maxAgeMs) {
		return cached.value;
	}
	// 주기 패스는 진행 중 fetch에 합류하고, 경계(0)는 항상 새로 시작한다 —
	// 검사 완료 이전에 시작된 관측이 경계 재검증의 근거가 되면 안 된다.
	if (options.maxAgeMs > 0 && inFlight) return inFlight;
	const settle = (
		result: Awaited<ReturnType<typeof fetchObservation>> | undefined,
	): ManagedControlPlaneObservation | undefined => {
		const value = result?.visibility.complete
			? {
					sessions: result.sessions,
					visibleDesktopIds: result.visibility.visibleDesktopIds,
				}
			: undefined;
		// A newer request retires shared publication, not this caller's result.
		if (inFlight === fetch) {
			// Store subscribers can reenter synchronously: advance the cache first.
			cached = { atMs: Date.now(), value };
			// Publish the complete metadata batch even if visibility is incomplete.
			if (result) {
				const store = useStore.getState();
				store.setHmuxSessionsMetadata(result.sessions);
				for (const { sessionId, state } of result.runtimeStates) {
					store.setSessionAgentRuntimeState(sessionId, state);
				}
			}
		}
		return value;
	};
	const fetch = fetchObservation()
		.then(settle)
		.catch((error) => {
			console.warn("[managed exact observation]", error);
			return settle(undefined);
		})
		.finally(() => {
			if (inFlight === fetch) inFlight = undefined;
		});
	inFlight = fetch;
	return fetch;
}

/** 테스트 전용 — 모듈 전역 캐시·비행 상태 격리. */
export function resetManagedControlPlaneObservationForTest(): void {
	cached = undefined;
	inFlight = undefined;
}
