import {
	ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
	type OnboardingImportDesktopDraft,
	type OnboardingImportDraft,
	type OnboardingImportDraftMutation,
	type OnboardingImportPaneDraft,
} from "@/lib/onboarding/onboardingImportDraft";

export type OnboardingImportRecency = "recent" | "older";

/** 목록이 보여 주는 기간 범위 — "recent"는 7일 이내만, "all"은 30일 전부. */
export type OnboardingImportScope = "recent" | "all";

export interface OnboardingImportSelectionCount {
	total: number;
	selected: number;
}

function matchesRecency(
	pane: OnboardingImportPaneDraft,
	recency: OnboardingImportRecency,
): boolean {
	// The clock-injected recent-work planner stamps this immutable 7-day bucket.
	// v1 journals without the field retain their legacy default-selection proxy.
	const bucket =
		pane.recencyBucket ?? (pane.defaultSelected ? "recent" : "older");
	return bucket === recency;
}

function updateMatchingPanes(
	draft: OnboardingImportDraft,
	desktopMatches: (desktop: OnboardingImportDesktopDraft) => boolean,
	paneMatches: (pane: OnboardingImportPaneDraft) => boolean,
	selected: boolean,
): OnboardingImportDraftMutation {
	const affected = draft.desktops.filter(
		(desktop) => desktop.included && desktopMatches(desktop),
	);
	if (
		selected &&
		affected.some(
			(desktop) =>
				desktop.panes.filter((pane) => pane.selected || paneMatches(pane))
					.length > ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
		)
	) {
		return { draft, error: "desktop_pane_limit" };
	}

	return {
		draft: {
			...draft,
			desktops: draft.desktops.map((desktop) => {
				if (!desktop.included || !desktopMatches(desktop)) return desktop;
				return {
					...desktop,
					panes: desktop.panes.map((pane) =>
						paneMatches(pane) ? { ...pane, selected } : pane,
					),
				};
			}),
		},
	};
}

/** 범위 안에 들어오는 pane — 이미 선택된 pane은 범위 밖이어도 계속 보인다.
 *  저장된 계획을 복원했을 때 만들어질 pane이 화면에서 사라지면 안 된다. */
export function onboardingImportScopePanes(
	desktop: OnboardingImportDesktopDraft,
	scope: OnboardingImportScope,
): readonly OnboardingImportPaneDraft[] {
	if (scope === "all") return desktop.panes;
	return desktop.panes.filter(
		(pane) => pane.selected || matchesRecency(pane, "recent"),
	);
}

/** 전체 개수는 스페이스를 껐다 켜도 흔들리지 않아야 한다 — 분모는 범위 안의 모든
 *  pane이고, 분자는 실제로 만들어질 pane(포함된 스페이스 + 선택된 pane)이다. */
export function onboardingImportScopeSelectionCount(
	draft: OnboardingImportDraft,
	scope: OnboardingImportScope,
): OnboardingImportSelectionCount {
	let total = 0;
	let selected = 0;
	for (const desktop of draft.desktops) {
		for (const pane of onboardingImportScopePanes(desktop, scope)) {
			total += 1;
			if (desktop.included && pane.selected) selected += 1;
		}
	}
	return { total, selected };
}

/** 맨 위 전체 체크박스 — pane을 목록에서 빼는 게 아니라 스페이스를 통째로
 *  껐다 켠다. 해제해도 pane은 그대로 보이고 카드만 비활성화된다. */
export function setAllOnboardingImportDesktopsIncluded(
	draft: OnboardingImportDraft,
	included: boolean,
): OnboardingImportDraftMutation {
	return {
		draft: {
			...draft,
			desktops: draft.desktops.map((desktop) => ({ ...desktop, included })),
		},
	};
}

export function setOnboardingImportScopeSelected(
	draft: OnboardingImportDraft,
	scope: OnboardingImportScope,
	selected: boolean,
): OnboardingImportDraftMutation {
	return updateMatchingPanes(
		draft,
		() => true,
		(pane) => scope === "all" || matchesRecency(pane, "recent"),
		selected,
	);
}

/** 범위를 "최근 7일"로 좁히면 화면에서 사라지는 7일 초과 pane의 선택도 함께
 *  해제한다 — 보이지 않는 선택이 그대로 만들어지면 화면과 결과가 어긋난다.
 *
 *  제외된 스페이스까지 훑는다. 일반 선택 동작(`updateMatchingPanes`)은 꺼진
 *  스페이스를 건너뛰지만, 여기서 건너뛰면 그 스페이스를 다시 켜는 순간 범위
 *  밖 선택이 되살아나 이 함수가 약속한 불변식이 깨진다. */
export function narrowOnboardingImportScope(
	draft: OnboardingImportDraft,
	scope: OnboardingImportScope,
): OnboardingImportDraft {
	if (scope === "all") return draft;
	const stale = (pane: OnboardingImportPaneDraft) =>
		pane.selected && matchesRecency(pane, "older");
	let changed = false;
	const desktops = draft.desktops.map((desktop) => {
		if (!desktop.panes.some(stale)) return desktop;
		changed = true;
		return {
			...desktop,
			panes: desktop.panes.map((pane) =>
				stale(pane) ? { ...pane, selected: false } : pane,
			),
		};
	});
	return changed ? { ...draft, desktops } : draft;
}

export function onboardingImportRecencySelectionCount(
	draft: OnboardingImportDraft,
	recency: OnboardingImportRecency,
): OnboardingImportSelectionCount {
	let total = 0;
	let selected = 0;
	for (const desktop of draft.desktops) {
		if (!desktop.included) continue;
		for (const pane of desktop.panes) {
			if (!matchesRecency(pane, recency)) continue;
			total += 1;
			if (pane.selected) selected += 1;
		}
	}
	return { total, selected };
}

export function onboardingImportSourceGroupSelectionCount(
	draft: OnboardingImportDraft,
	sourceGroupIdentity: string,
): OnboardingImportSelectionCount {
	let total = 0;
	let selected = 0;
	for (const desktop of draft.desktops) {
		if (!desktop.included) continue;
		for (const pane of desktop.panes) {
			if (pane.groupIdentity !== sourceGroupIdentity) continue;
			total += 1;
			if (pane.selected) selected += 1;
		}
	}
	return { total, selected };
}

export function setOnboardingImportRecencySelected(
	draft: OnboardingImportDraft,
	recency: OnboardingImportRecency,
	selected: boolean,
): OnboardingImportDraftMutation {
	return updateMatchingPanes(
		draft,
		() => true,
		(pane) => matchesRecency(pane, recency),
		selected,
	);
}

export function setOnboardingImportDesktopPanesSelected(
	draft: OnboardingImportDraft,
	desktopId: string,
	selected: boolean,
): OnboardingImportDraftMutation {
	if (!draft.desktops.some((desktop) => desktop.id === desktopId)) {
		return { draft, error: "desktop_not_found" };
	}
	return updateMatchingPanes(
		draft,
		(desktop) => desktop.id === desktopId,
		() => true,
		selected,
	);
}

export function setOnboardingImportSourceGroupSelected(
	draft: OnboardingImportDraft,
	sourceGroupIdentity: string,
	selected: boolean,
): OnboardingImportDraftMutation {
	return updateMatchingPanes(
		draft,
		() => true,
		(pane) => pane.groupIdentity === sourceGroupIdentity,
		selected,
	);
}
