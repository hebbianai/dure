import { describe, expect, it } from "vitest";
import {
	buildOnboardingImportDraft,
	moveOnboardingImportPane,
	type OnboardingImportProjection,
} from "@/lib/onboarding/onboardingImportDraft";
import {
	narrowOnboardingImportScope,
	onboardingImportRecencySelectionCount,
	onboardingImportScopePanes,
	onboardingImportScopeSelectionCount,
	onboardingImportSourceGroupSelectionCount,
	setAllOnboardingImportDesktopsIncluded,
	setOnboardingImportDesktopPanesSelected,
	setOnboardingImportRecencySelected,
	setOnboardingImportScopeSelected,
	setOnboardingImportSourceGroupSelected,
} from "@/lib/onboarding/onboardingImportSelection";

function projection(): OnboardingImportProjection {
	return {
		total: 11,
		groups: [
			{
				id: "repo:one",
				name: "One",
				cwd: "/one",
				items: Array.from({ length: 10 }, (_, index) => ({
					key: `codex:${index}`,
					conversationId: `conversation-${index}`,
					title: `Conversation ${index}`,
					mtime: 100 - index,
					provider: "codex" as const,
					cwd: `/one/${index}`,
					workspaceRoot: "/one",
					groupIdentity: "repo:one",
					defaultSelected: index < 3,
					recencyBucket: index < 3 ? ("recent" as const) : ("older" as const),
					executionLocation: "local" as const,
				})),
			},
			{
				id: "repo:two",
				name: "Two",
				cwd: "/two",
				items: [
					{
						key: "claude:two",
						conversationId: "conversation-two",
						title: "Conversation two",
						mtime: 99,
						provider: "claude" as const,
						cwd: "/two",
						workspaceRoot: "/two",
						groupIdentity: "repo:two",
						defaultSelected: true,
						recencyBucket: "recent" as const,
						executionLocation: "local" as const,
					},
				],
			},
		],
	};
}

describe("onboarding import bulk selection", () => {
	it("counts and changes recent and older panes independently", () => {
		const draft = buildOnboardingImportDraft(projection());
		expect(onboardingImportRecencySelectionCount(draft, "recent")).toEqual({
			total: 4,
			selected: 4,
		});
		expect(onboardingImportRecencySelectionCount(draft, "older")).toEqual({
			total: 7,
			selected: 0,
		});

		const olderSelected = setOnboardingImportRecencySelected(
			draft,
			"older",
			true,
		).draft;
		expect(
			onboardingImportRecencySelectionCount(olderSelected, "older"),
		).toEqual({
			total: 7,
			selected: 7,
		});
		const recentCleared = setOnboardingImportRecencySelected(
			olderSelected,
			"recent",
			false,
		).draft;
		expect(
			onboardingImportRecencySelectionCount(recentCleared, "recent").selected,
		).toBe(0);
	});

	it("keeps a recent one-shot pane in the recent bucket while leaving it unselected", () => {
		const draft = buildOnboardingImportDraft(projection());
		const firstDesktop = draft.desktops[0];
		const oneShot = {
			...firstDesktop.panes[0],
			defaultSelected: false,
			selected: false,
			recencyBucket: "recent" as const,
		};
		const withOneShot = {
			...draft,
			desktops: [
				{ ...firstDesktop, panes: [oneShot, ...firstDesktop.panes.slice(1)] },
				...draft.desktops.slice(1),
			],
		};

		expect(
			onboardingImportRecencySelectionCount(withOneShot, "recent"),
		).toEqual({ total: 4, selected: 3 });
		expect(
			onboardingImportRecencySelectionCount(withOneShot, "older"),
		).toEqual({ total: 7, selected: 0 });
	});

	it("selects one desktop without changing another", () => {
		const draft = buildOnboardingImportDraft(projection());
		const first = draft.desktops[0];
		const selected = setOnboardingImportDesktopPanesSelected(
			draft,
			first.id,
			true,
		).draft;

		expect(selected.desktops[0].panes.every((pane) => pane.selected)).toBe(
			true,
		);
		expect(selected.desktops[1].panes.every((pane) => !pane.selected)).toBe(
			true,
		);
		expect(selected.desktops[2].panes[0].selected).toBe(true);
	});

	it("keeps repository selection attached to pane identity after a move", () => {
		const draft = buildOnboardingImportDraft(projection());
		const movedPane = draft.desktops[0].panes[3];
		const moved = moveOnboardingImportPane(
			draft,
			movedPane.key,
			draft.desktops[0].id,
			draft.desktops[2].id,
		).draft;
		const selected = setOnboardingImportSourceGroupSelected(
			moved,
			"repo:one",
			true,
		).draft;

		expect(
			onboardingImportSourceGroupSelectionCount(selected, "repo:one"),
		).toEqual({
			total: 10,
			selected: 10,
		});
		expect(
			selected.desktops[2].panes.find((pane) => pane.key === movedPane.key)
				?.selected,
		).toBe(true);
	});

	it("fails atomically when a bulk action would exceed the desktop pane limit", () => {
		const draft = buildOnboardingImportDraft(projection());
		const unselected = draft.desktops[1].panes[0];
		const moved = moveOnboardingImportPane(
			draft,
			unselected.key,
			draft.desktops[1].id,
			draft.desktops[0].id,
		).draft;
		const mutation = setOnboardingImportDesktopPanesSelected(
			moved,
			moved.desktops[0].id,
			true,
		);

		expect(mutation.error).toBe("desktop_pane_limit");
		expect(mutation.draft).toBe(moved);
	});
});

describe("onboarding import scope", () => {
	it("hides older panes from the recent scope but keeps selected ones visible", () => {
		const draft = buildOnboardingImportDraft(projection());
		const desktop = draft.desktops[0];
		expect(desktop.panes).toHaveLength(8);
		expect(onboardingImportScopePanes(desktop, "all")).toHaveLength(8);
		expect(onboardingImportScopePanes(desktop, "recent")).toHaveLength(3);

		// 7일 초과인데 이미 선택된 pane은 좁힌 범위에서도 계속 보인다 — 만들어질
		// pane이 화면에서 사라지면 화면과 결과가 어긋난다.
		const withOlderSelected = setOnboardingImportRecencySelected(
			draft,
			"older",
			true,
		).draft;
		expect(
			onboardingImportScopePanes(withOlderSelected.desktops[0], "recent"),
		).toHaveLength(8);
	});

	it("counts and selects only what the scope shows", () => {
		const draft = buildOnboardingImportDraft(projection());
		expect(onboardingImportScopeSelectionCount(draft, "recent")).toEqual({
			total: 4,
			selected: 4,
		});
		expect(onboardingImportScopeSelectionCount(draft, "all")).toEqual({
			total: 11,
			selected: 4,
		});

		const cleared = setOnboardingImportScopeSelected(draft, "recent", false).draft;
		expect(onboardingImportScopeSelectionCount(cleared, "all")).toEqual({
			total: 11,
			selected: 0,
		});
	});

	it("clears out-of-scope selections when narrowing to the recent scope", () => {
		const draft = setOnboardingImportRecencySelected(
			buildOnboardingImportDraft(projection()),
			"older",
			true,
		).draft;
		expect(onboardingImportRecencySelectionCount(draft, "older").selected).toBe(7);

		expect(
			onboardingImportRecencySelectionCount(
				narrowOnboardingImportScope(draft, "recent"),
				"older",
			).selected,
		).toBe(0);
		// 전체 범위로 넓히는 것은 선택을 건드리지 않는다.
		expect(narrowOnboardingImportScope(draft, "all")).toBe(draft);
	});

	it("also clears out-of-scope selections inside excluded spaces", () => {
		const selected = setOnboardingImportRecencySelected(
			buildOnboardingImportDraft(projection()),
			"older",
			true,
		).draft;
		// 스페이스를 끈 뒤 범위를 좁힌다 — 꺼져 있다고 건너뛰면 다시 켜는 순간
		// 7일 초과 선택이 되살아난다.
		const excluded = setAllOnboardingImportDesktopsIncluded(selected, false).draft;
		const narrowed = narrowOnboardingImportScope(excluded, "recent");
		const reincluded = setAllOnboardingImportDesktopsIncluded(narrowed, true).draft;

		expect(
			onboardingImportRecencySelectionCount(reincluded, "older").selected,
		).toBe(0);
	});

	it("returns the same draft when nothing is out of scope", () => {
		const draft = buildOnboardingImportDraft(projection());
		expect(narrowOnboardingImportScope(draft, "recent")).toBe(draft);
	});
});

describe("onboarding import include-all toggle", () => {
	it("turns every space off without touching pane selection", () => {
		const draft = buildOnboardingImportDraft(projection());
		const excluded = setAllOnboardingImportDesktopsIncluded(draft, false).draft;

		expect(excluded.desktops.every((desktop) => !desktop.included)).toBe(true);
		// pane 선택은 그대로 남아야 다시 켰을 때 원래 구성이 돌아온다.
		expect(
			excluded.desktops.flatMap((desktop) => desktop.panes).filter((p) => p.selected),
		).toHaveLength(4);
		expect(
			setAllOnboardingImportDesktopsIncluded(excluded, true).draft.desktops.every(
				(desktop) => desktop.included,
			),
		).toBe(true);
	});

	it("keeps the scope total stable while spaces are off", () => {
		const draft = buildOnboardingImportDraft(projection());
		const before = onboardingImportScopeSelectionCount(draft, "all");
		const excluded = setAllOnboardingImportDesktopsIncluded(draft, false).draft;
		const after = onboardingImportScopeSelectionCount(excluded, "all");

		expect(before).toEqual({ total: 11, selected: 4 });
		// 분모는 그대로, 만들어질 pane만 0이 된다 — 목록이 사라지지 않았다는 뜻.
		expect(after).toEqual({ total: 11, selected: 0 });
	});
});
