// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => ["claude", "codex"],
	useQuickStartProviders: (limit: number) => ({
		available: ["claude", "codex"],
		quick: ["claude", "codex"].slice(0, limit),
	}),
}));
vi.mock("@/lib/spaces/spaceRepositoryGroups", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/spaces/spaceRepositoryGroups")>();
	return {
		...original,
		repositoryRemoteHostId: vi.fn(original.repositoryRemoteHostId),
	};
});

import { SpacesRepositoryGroup } from "@/components/spaces/SpacesRepositoryGroup";
import type { SpaceMenuHandlers } from "@/components/spaces/SpacesRows";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import { repositoryRemoteHostId } from "@/lib/spaces/spaceRepositoryGroups";
import type { Project } from "@/types";
import { hoverHint } from "@/test/tooltip";

function makeRow(key: string, title: string): SpaceRow {
	return {
		key,
		desktopId: "desk-1",
		sessionId: `session-${key}`,
		kind: "term",
		cwd: "/repo",
		title,
		detail: "detail",
		projectId: "p1",
		projectName: "Dure",
		hostLabel: "local",
		provider: null,
		managedPromotion: "hidden",
		unread: false,
	} as SpaceRow;
}

const menuHandlers: SpaceMenuHandlers = {
	onViewDiff: vi.fn(),
	onMoveToDesktop: vi.fn(),
	onMoveToNewDesktop: vi.fn(),
	onRestart: vi.fn(),
	onFork: vi.fn(),
	onPromoteManaged: vi.fn(),
	onSwitchAccount: vi.fn(),
	onKill: vi.fn(),
};

const PROJECTS: Project[] = [
	{ id: "p1", name: "Dure", path: "/repo", kind: "local", isRepo: true },
];

const addActions = {
	onAddRepositoryTerminal: vi.fn(),
	onAddRepositoryAgent: vi.fn(async () => {}),
	onAddRepositoryAgentWithOptions: vi.fn(),
};

function groupProps(rows: readonly SpaceRow[], projects: Project[] = PROJECTS) {
	return {
		group: { key: '["project","p1"]', label: "Dure", spaces: rows },
		desktopId: "desk-1",
		...addActions,
		isFirst: true,
		projects,
		sshHosts: [],
		visibleFields: [],
		groupBy: "repository" as const,
		showSpaces: true,
		diffCapabilities: new Map(),
		selected: new Set<string>(),
		contextMenuKey: null,
		conversionBusyKeys: new Set<string>(),
		selectedPromotionEligible: 0,
		selectedPromotionDeferred: 0,
		onSpaceClick: vi.fn() as (
			event: ReactMouseEvent,
			key: string,
			desktopId: string,
		) => void,
		onContextMenuOpenChange: vi.fn(),
		onRowDragStart: vi.fn(),
		onRowDragEnd: vi.fn(),
		menuHandlers,
		killConfirm: null,
		onKillConfirm: vi.fn(),
		onKillCancel: vi.fn(),
	} as const;
}

describe("SpacesRepositoryGroup", () => {
	// 이 설정에는 자동 cleanup이 없다 — 없으면 앞 테스트의 DOM이 남아
	// 같은 이름의 region이 둘이 되고 getByRole이 실패한다.
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("labels the repository region and preserves row order", () => {
		const rows = [makeRow("term:1", "pane one"), makeRow("term:2", "pane two")];
		render(<SpacesRepositoryGroup {...groupProps(rows)} />);

		const group = screen.getByRole("region", { name: "Dure" });
		expect(group.getAttribute("data-space-repository-group")).toBe(
			'["project","p1"]',
		);
		expect(
			[...group.querySelectorAll("[data-space-key]")].map((row) =>
				row.getAttribute("data-space-key"),
			),
		).toEqual(["term:1", "term:2"]);
		expect(within(group).getByText("pane one")).toBeTruthy();
	});

	it("badges a remote repository with the host name as its tooltip", async () => {
		const remoteProjects: Project[] = [
			{
				id: "p1",
				name: "Dure",
				path: "/repo",
				kind: "ssh",
				sshHostId: "h1",
				isRepo: true,
			},
		];
		render(
			<SpacesRepositoryGroup
				{...groupProps([makeRow("term:1", "pane one")], remoteProjects)}
				sshHosts={[
					{
						id: "h1",
						name: "gate1",
						host: "gate1.example",
						port: 22,
						user: "dev",
						auth: "auto",
					},
				]}
			/>,
		);

		const badge = screen.getByText("SSH");
		expect(badge.getAttribute("title")).toBeNull();
		expect(await hoverHint(badge)).toBe("gate1");
		// 배지 텍스트가 영역 이름을 오염시키면 안 된다 — 제목은 저장소 이름뿐이다.
		expect(screen.getByRole("region", { name: "Dure" })).toBeTruthy();
	});

	it("omits the badge for a local repository", () => {
		render(
			<SpacesRepositoryGroup
				{...groupProps([makeRow("term:1", "pane one")])}
			/>,
		);
		expect(screen.queryByText("SSH")).toBeNull();
	});

	/** 호스트 이름을 못 찾아도 원격이라는 사실 자체는 잃지 않는다 — 판정은
	 *  프로젝트 기록이 하고 라벨은 툴팁일 뿐이다. */
	it("still badges a remote repository with no resolvable host name", () => {
		const remoteProjects: Project[] = [
			{
				id: "p1",
				name: "Dure",
				path: "/repo",
				kind: "ssh",
				sshHostId: "h-gone",
				isRepo: true,
			},
		];
		render(
			<SpacesRepositoryGroup
				{...groupProps([makeRow("term:1", "pane one")], remoteProjects)}
			/>,
		);
		expect(screen.getByText("SSH")).toBeTruthy();
	});

	describe("quick add", () => {
		function openQuickAdd() {
			fireEvent.pointerDown(
				screen.getByRole("button", { name: "Dure에 추가" }),
				{
					button: 0,
					ctrlKey: false,
				},
			);
		}

		it("opens a terminal in the repository's registered folder", async () => {
			render(
				<SpacesRepositoryGroup
					{...groupProps([makeRow("term:1", "pane one")])}
				/>,
			);

			openQuickAdd();
			fireEvent.click(
				await screen.findByRole("menuitem", { name: "터미널 열기" }),
			);

			expect(addActions.onAddRepositoryTerminal).toHaveBeenCalledWith(
				"desk-1",
				{ label: "Dure", path: "/repo", projectId: "p1" },
			);
		});

		it("starts the chosen provider on the same repository", async () => {
			render(
				<SpacesRepositoryGroup
					{...groupProps([makeRow("term:1", "pane one")])}
				/>,
			);

			openQuickAdd();
			fireEvent.click(
				await screen.findByRole("menuitem", { name: "여기서 Codex 시작" }),
			);

			expect(addActions.onAddRepositoryAgent).toHaveBeenCalledWith(
				"desk-1",
				{ label: "Dure", path: "/repo", projectId: "p1" },
				"codex",
			);
		});

		/** 시작할 폴더를 아무 pane도 모르는 그룹에는 붙일 곳이 없다 — 세션 cwd를
		 *  아직 못 읽은 행의 cwd는 빈 문자열이다(useSpaces). */
		it("omits the menu when the group knows no folder", () => {
			const row: SpaceRow = {
				...makeRow("term:1", "pane one"),
				projectId: undefined,
				cwd: "",
			};
			render(<SpacesRepositoryGroup {...groupProps([row], [])} />);

			expect(screen.queryByTitle("Dure에 추가")).toBeNull();
		});
	});

	it("keeps the armed row and puts the in-place kill confirm under it", () => {
		const rows = [makeRow("term:1", "pane one"), makeRow("term:2", "pane two")];
		const onKillConfirm = vi.fn();
		render(
			<SpacesRepositoryGroup
				{...groupProps(rows)}
				killConfirm={{
					anchorKey: "term:2",
					question: "Kill this session?",
					busy: false,
				}}
				onKillConfirm={onKillConfirm}
			/>,
		);

		expect(screen.getByText("pane one")).toBeTruthy();
		// The row stays — it is what says which session is about to end —
		// and the question follows it (owner call 2026-09-14; it used to
		// replace the row).
		const armed = screen.getByText("pane two");
		const confirmRow = screen.getByRole("alertdialog");
		expect(confirmRow.textContent).toContain("Kill this session?");
		expect(
			armed.compareDocumentPosition(confirmRow) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		fireEvent.click(within(confirmRow).getByText("종료"));
		expect(onKillConfirm).toHaveBeenCalledOnce();
	});

	it("bails out for a fresh group object carrying identical rows", () => {
		const rows = [makeRow("term:1", "pane one")];
		const props = groupProps(rows);
		const { rerender } = render(<SpacesRepositoryGroup {...props} />);
		expect(vi.mocked(repositoryRemoteHostId).mock.calls.length).toBe(1);

		// A recomputed grouping produces new group/array objects around the
		// same reused row objects — the memo must compare rows, not wrappers.
		rerender(
			<SpacesRepositoryGroup
				{...props}
				group={{ ...props.group, spaces: [...rows] }}
			/>,
		);
		expect(vi.mocked(repositoryRemoteHostId).mock.calls.length).toBe(1);

		// A genuinely changed row re-renders the group.
		rerender(
			<SpacesRepositoryGroup
				{...props}
				group={{ ...props.group, spaces: [makeRow("term:1", "renamed")] }}
			/>,
		);
		expect(vi.mocked(repositoryRemoteHostId).mock.calls.length).toBe(2);
	});
});
