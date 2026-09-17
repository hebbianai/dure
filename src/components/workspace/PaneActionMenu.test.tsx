// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PaneActionContextMenu,
  PaneActionDropdown,
  type PaneActionMenuSection,
} from "@/components/workspace/PaneActionMenu";
import { buildPaneActionMenuSections } from "@/components/workspace/PaneActionMenuSections";

const sections: PaneActionMenuSection[] = [
  {
    id: "split",
    hiddenOn: "dropdown",
    foldedIntoMenu: true,
    items: [{ id: "split-right", label: "오른쪽으로 분할", onSelect: () => {} }],
  },
  {
    id: "pane",
    items: [
      {
        id: "hide",
        label: "Pane 숨기기",
        hint: "Spaces에 유지",
        onSelect: () => {},
      },
    ],
  },
];

/**
 * 구분선까지 포함한 행 순서.
 *
 * `hiddenOn`의 진짜 위험은 항목이 아니라 구분선이다 — 걸러내기 전 인덱스로
 * 그리면 남은 첫 섹션 위에 선이 하나 뜬다. menuitem만 세면 그게 통과한다.
 */
function rowsIn(menu: HTMLElement) {
  return Array.from(
    menu.querySelectorAll<HTMLElement>("[role='menuitem'],[role='separator']"),
    (row) => (row.getAttribute("role") === "separator" ? "---" : row.textContent),
  );
}

afterEach(cleanup);

function OpenedDropdown({
  sections,
  headerFolded,
}: {
  sections: PaneActionMenuSection[];
  headerFolded?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <PaneActionDropdown
      open={open}
      onOpenChange={setOpen}
      sections={sections}
      headerFolded={headerFolded}
      trigger={<button type="button">Pane 메뉴</button>}
    />
  );
}

describe("a folded header hands its split buttons to the ⋯ menu", () => {
  it("keeps the split section out of the dropdown while the header shows the buttons", async () => {
    render(<OpenedDropdown sections={sections} />);
    const menu = await screen.findByRole("menu");
    expect(rowsIn(menu)).toEqual(["Pane 숨기기Spaces에 유지"]);
  });

  it("shows the split section in the dropdown once the header has folded them", async () => {
    render(<OpenedDropdown sections={sections} headerFolded />);
    const menu = await screen.findByRole("menu");
    expect(rowsIn(menu)).toEqual(["오른쪽으로 분할", "---", "Pane 숨기기Spaces에 유지"]);
  });
});

function builderArgs(overrides: Record<string, unknown> = {}) {
	return {
		agent: {
			id: "agent-1",
			name: "agent-1",
			provider: "codex",
			projectId: "project-1",
			worktreePath: "/repo/.worktrees/agent-1",
			branch: "agent/agent-1",
			sessionId: "session-1",
			sessionKind: "pty",
		},
		changePermissionMode: vi.fn(),
		closePane: () => {},
		conversionBusy: false,
		conversionTarget: "standalone",
		convertSession: () => {},
		copyIdentifier: () => {},
		delegateTask: vi.fn(),
		desktopId: "space-1",
		desktopKind: undefined,
		hide: undefined,
		history: undefined,
		hostId: "local",
		newAgent: () => {},
		openAgentRename: undefined,
		openPaneInfo: () => {},
		openPaneRename: () => {},
		panelId: "agent:agent-1",
		file: undefined,
		permissionModeBusy: false,
		pinned: false,
		rehostAvailable: true,
		rehostBusy: false,
		recentSshHostId: undefined,
		rehostToCurrentBuild: () => {},
		removableWorktree: false,
		splitPane: () => {},

		splitSshPane: () => {},
		splitTerminalPane: () => {},
		sshHosts: [],
		switchCandidates: [],
		switchToAgent: () => {},
		togglePin: () => {},
		deleteAgent: () => {},
		...overrides,
	} as never;
}

const sshHostFixture = (id: string, name: string) => ({
	id,
	name,
	host: `${id}.example`,
	port: 22,
	user: "dure",
	auth: "auto" as const,
});

/** 우클릭 메뉴를 열고 분할 서브트리거 하나를 펼친다. */
async function openSplitSubmenu(args: never, name: string) {
	const { container } = render(
		<PaneActionContextMenu sections={buildPaneActionMenuSections(args)}>
			<div data-testid="chrome">pane</div>
		</PaneActionContextMenu>,
	);
	fireEvent.contextMenu(
		container.querySelector("[data-testid='chrome']") as HTMLElement,
		{ clientX: 10, clientY: 10 },
	);
	const trigger = await screen.findByRole("menuitem", { name });
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "ArrowRight" });
	return screen.findByRole("menu", { name });
}

function sectionItemIds(
	sections: ReturnType<typeof buildPaneActionMenuSections>,
): string[] {
	return sections.flatMap((section) => section.items.map((item) => item.id));
}

describe("pane action menu basic-mode folding", () => {
	it("folds plumbing/orchestration entries and keeps journey + safety paths", () => {
		const FOLDED = [
			"copy-host-id",
			"copy-pane-id",
			"pin",
			"popout",
			"delegate-task",
			"fork",
			"permission-mode",
			"rehost",
			"convert-standalone",
		];
		// Pro shows every folded candidate — keeps the absence checks honest.
		const proIds = sectionItemIds(
			buildPaneActionMenuSections(builderArgs()),
		);
		for (const folded of FOLDED) {
			expect(proIds).toContain(folded);
		}

		const ids = sectionItemIds(
			buildPaneActionMenuSections(builderArgs({ basicInterface: true })),
		);
		for (const folded of FOLDED) {
			expect(ids).not.toContain(folded);
		}
		for (const kept of ["pane-info", "delete-agent", "close"]) {
			expect(ids).toContain(kept);
		}
	});

	it("keeps pin while pinned and the popout return path in a popout window", () => {
		const pinnedIds = sectionItemIds(
			buildPaneActionMenuSections(
				builderArgs({ basicInterface: true, pinned: true }),
			),
		);
		expect(pinnedIds).toContain("pin");

		const popoutIds = sectionItemIds(
			buildPaneActionMenuSections(
				builderArgs({ basicInterface: true, desktopKind: "popout" }),
			),
		);
		expect(popoutIds).toContain("popout");
	});
});

describe("pane action menu surfaces", () => {
  it("copies a bounded transcript from the pane dropdown submenu", async () => {
    const copyTranscript = vi.fn();
    const menuSections = buildPaneActionMenuSections(
      builderArgs({ copyTranscript }),
    );
    const paneItemIds =
      menuSections
        .find((section) => section.id === "pane")
        ?.items.map((item) => item.id) ?? [];
    expect(
      paneItemIds.slice(
        paneItemIds.indexOf("pane-info"),
        paneItemIds.indexOf("copy-host-id") + 1,
      ),
    ).toEqual(["pane-info", "copy-transcript", "copy-host-id"]);
    render(
      <OpenedDropdown sections={menuSections} />,
    );

    const subTrigger = await screen.findByRole("menuitem", {
      name: "대화 기록 복사",
    });
    subTrigger.focus();
    fireEvent.keyDown(subTrigger, { key: "ArrowRight" });
    expect(
      await screen.findByRole("menuitem", { name: "최근 20개 항목" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "전체 대화" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "최근 50개 항목" }),
    );

    await waitFor(() => expect(copyTranscript).toHaveBeenCalledWith(50));
  });

  it("opens the exact pane workspace through the shared external target catalog", async () => {
    const openExternalWorkspace = vi.fn();
    const menuSections = buildPaneActionMenuSections({
      agent: {
        id: "agent-1",
        name: "agent-1",
        provider: "codex",
        projectId: "project-1",
        worktreePath: "/repo/.worktrees/agent-1",
        branch: "agent/agent-1",
        sessionId: "session-1",
        sessionKind: "pty",
      },
      changePermissionMode: undefined,
      closePane: () => {},
      conversionBusy: false,
      conversionTarget: undefined,
      convertSession: () => {},
      copyIdentifier: () => {},
      delegateTask: undefined,
      desktopId: "space-1",
      desktopKind: undefined,
      externalOpenTargets: [
        {
          id: "finder",
          label: "Finder",
          group: "finder",
          capability: "directory",
          platforms: ["macos"],
        },
        {
          id: "cursor",
          label: "Cursor",
          group: "editor",
          capability: "directory",
          platforms: ["macos"],
        },
        {
          id: "terminal",
          label: "Terminal",
          group: "terminal",
          capability: "directory",
          platforms: ["macos"],
        },
      ],
      hide: undefined,
      history: undefined,
      hostId: "local",
      newAgent: () => {},
      openAgentRename: undefined,
      openExternalWorkspace,
      openPaneInfo: () => {},
      openPaneRename: () => {},
      panelId: "agent:agent-1",
      file: undefined,
      permissionModeBusy: false,
      pinned: false,
      rehostAvailable: false,
      rehostBusy: false,
      recentSshHostId: undefined,
      rehostToCurrentBuild: () => {},
      removableWorktree: false,
      splitPane: () => {},

      splitSshPane: () => {},
      splitTerminalPane: () => {},
      sshHosts: [],
      switchCandidates: [],
      switchToAgent: () => {},
      togglePin: () => {},
      deleteAgent: () => {},
    } as never);
    render(
      <OpenedDropdown sections={menuSections} />,
    );

    const subTrigger = await screen.findByRole("menuitem", {
      name: "다른 앱에서 열기",
    });
    subTrigger.focus();
    fireEvent.keyDown(subTrigger, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Cursor/ }));

    await waitFor(() => expect(openExternalWorkspace).toHaveBeenCalledWith("cursor"));
  });

  it("offers permission-mode relaunch separately from current-build rehost", async () => {
    const changePermissionMode = vi.fn();
    const menuSections = buildPaneActionMenuSections({
      agent: {
        id: "agent-1",
        name: "agent-1",
        provider: "codex",
        projectId: "project-1",
        worktreePath: "/repo/.worktrees/agent-1",
        branch: "agent/agent-1",
        sessionId: "session-1",
        sessionKind: "pty",
      },
      changePermissionMode,
      closePane: () => {},
      conversionBusy: false,
      conversionTarget: undefined,
      convertSession: () => {},
      copyIdentifier: () => {},
      delegateTask: undefined,
      desktopId: "desktop-1",
      desktopKind: undefined,
      hide: undefined,
      history: undefined,
      hostId: "local",
      newAgent: () => {},
      openAgentRename: undefined,
      openPaneInfo: () => {},
      openPaneRename: () => {},
      panelId: "agent:agent-1",
      file: undefined,
      permissionModeBusy: false,
      pinned: false,
      rehostAvailable: true,
      rehostBusy: false,
      recentSshHostId: undefined,
      rehostToCurrentBuild: () => {},
      removableWorktree: false,
      splitPane: () => {},

      splitSshPane: () => {},
      splitTerminalPane: () => {},
      sshHosts: [],
      switchCandidates: [],
      switchToAgent: () => {},
      togglePin: () => {},
      deleteAgent: () => {},
    } as never);
    render(
      <OpenedDropdown sections={menuSections} />,
    );

    expect(
      await screen.findByRole("menuitem", { name: "현재 빌드로 재호스트" }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "권한 모드 변경…" }),
    );
    await waitFor(() => expect(changePermissionMode).toHaveBeenCalledOnce());
  });

  it("offers task delegation from the pane dropdown", async () => {
    const delegate = vi.fn();
    const menuSections = buildPaneActionMenuSections({
      agent: undefined,
      closePane: () => {},
      conversionBusy: false,
      conversionTarget: undefined,
      convertSession: () => {},
      copyIdentifier: () => {},
      delegateTask: delegate,
      desktopId: "desktop-1",
      desktopKind: undefined,
      hide: undefined,
      history: undefined,
      hostId: undefined,
      newAgent: () => {},
      openAgentRename: undefined,
      openPaneInfo: () => {},
      openPaneRename: () => {},
      panelId: "agent:agent-1",
      file: undefined,
      pinned: false,
      rehostAvailable: false,
      rehostBusy: false,
      recentSshHostId: undefined,
      rehostToCurrentBuild: () => {},
      removableWorktree: false,
      splitPane: () => {},

      splitSshPane: () => {},
      splitTerminalPane: () => {},
      sshHosts: [],
      switchCandidates: [],
      switchToAgent: () => {},
      togglePin: () => {},
      deleteAgent: () => {},
    });
    render(
      <OpenedDropdown sections={menuSections} />,
    );

    fireEvent.click(await screen.findByRole("menuitem", { name: "작업 위임" }));
    await waitFor(() => expect(delegate).toHaveBeenCalledOnce());
  });

  it("omits a dropdown-hidden section from the ⋮ menu", async () => {
    render(
      <PaneActionDropdown
        open
        onOpenChange={() => {}}
        sections={sections}
        trigger={<button type="button">Pane 메뉴</button>}
      />,
    );

    // 분할이 빠지고 남은 유일한 섹션 위에 구분선이 서면 안 된다.
    expect(rowsIn(await screen.findByRole("menu"))).toEqual([
      "Pane 숨기기Spaces에 유지",
    ]);
  });

  it("keeps that same section on the right-click menu", async () => {
    const { container } = render(
      <PaneActionContextMenu sections={sections}>
        <div data-testid="chrome">pane</div>
      </PaneActionContextMenu>,
    );

    fireEvent.contextMenu(
      container.querySelector("[data-testid='chrome']") as HTMLElement,
      { clientX: 10, clientY: 10 },
    );

    expect(rowsIn(await screen.findByRole("menu"))).toEqual([
      "오른쪽으로 분할",
      "---",
      "Pane 숨기기Spaces에 유지",
    ]);
  });

  it("asks what to open after the split direction, SSH hosts included", async () => {
    const submenu = await openSplitSubmenu(
      builderArgs({

        sshHosts: [sshHostFixture("h1", "SSH 1"), sshHostFixture("h2", "SSH 2")],
        recentSshHostId: "h1",
      }),
      "아래로 분할",
    );

    // 이어받기 두 갈래와 호스트 목록 사이에만 구분선이 선다(시안 472:26050).
    expect(rowsIn(submenu)).toEqual([
      "새 pane",
      "터미널",
      "---",
      "SSH 1최근",
      "SSH 2",
    ]);
    // 목록 제목은 고를 수 있는 항목이 아니다 — menuitem으로 세지 않는다.
    expect(submenu.textContent).toContain("SSH");
  });

  it("opens the chosen host in the chosen direction", async () => {
    const splitSshPane = vi.fn();
    const host = sshHostFixture("h1", "SSH 1");
    // 예전 "SSH로 분할"은 방향이 "right"로 박혀 있어 아래쪽 SSH 분할이
    // 메뉴에 존재하지 않았다.
    const submenu = await openSplitSubmenu(
      builderArgs({ sshHosts: [host], splitSshPane }),
      "아래로 분할",
    );

    fireEvent.click(
      Array.from(
        submenu.querySelectorAll<HTMLElement>("[role='menuitem']"),
      ).find((row) => row.textContent === "SSH 1") as HTMLElement,
    );
    await waitFor(() =>
      expect(splitSshPane).toHaveBeenCalledWith("below", host),
    );
  });

  it("drops the host group when no SSH host is registered", async () => {
    const submenu = await openSplitSubmenu(
      builderArgs({ sshHosts: [] }),
      "오른쪽으로 분할",
    );

    // 빈 그룹이 남으면 고아 구분선과 빈 "SSH" 제목이 선다.
    expect(rowsIn(submenu)).toEqual(["새 pane", "터미널"]);
    expect(submenu.textContent).not.toContain("SSH");
  });

  it("portals a submenu out of the parent's overflow container", async () => {
    render(
      <PaneActionDropdown
        open
        onOpenChange={() => {}}
        sections={[
          {
            id: "swap",
            items: [
              {
                id: "switch-agent",
                label: "에이전트로 교체",
                groups: [
                  {
                    id: "candidates",
                    items: [
                      {
                        id: "new",
                        label: "새 에이전트 시작…",
                        onSelect: () => {},
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ]}
        trigger={<button type="button">Pane 메뉴</button>}
      />,
    );

    const parent = await screen.findByRole("menu");
    // 부모 패널은 스크롤 컨테이너다 — 자손으로 남으면 옆으로 열린 서브메뉴가
    // 가로로 잘린다. Radix MenuSubContent는 Portal이 없으면 여기 그대로 그려진다.
    expect(parent.className).toContain("overflow-x-hidden");
    const subTrigger = screen.getByRole("menuitem", { name: "에이전트로 교체" });
    subTrigger.focus();
    fireEvent.keyDown(subTrigger, { key: "ArrowRight" });

    const submenu = await screen.findByRole("menu", { name: "에이전트로 교체" });
    expect(parent.contains(submenu)).toBe(false);
  });

  it("renders a hint as a right-aligned column, not a second line", async () => {
    render(
      <PaneActionDropdown
        open
        onOpenChange={() => {}}
        sections={[sections[1]]}
        trigger={<button type="button">Pane 메뉴</button>}
      />,
    );

    const hint = await screen.findByText("Spaces에 유지");
    // 힌트를 오른쪽 끝으로 미는 건 힌트가 아니라 라벨의 flex-1이다.
    expect(screen.getByText("Pane 숨기기").parentElement?.className).toContain(
      "flex-1",
    );
    // 라벨보다 늦게 줄되, 라벨을 0으로 만들면서까지 버티지는 않는다.
    expect(hint.className).toContain("shrink-0");
    expect(hint.className).toContain("truncate");
    expect(hint.className).toContain("max-w-1/2");
    // 힌트가 붙은 항목만 오른쪽 여백이 10px이다.
    expect(
      screen.getByRole("menuitem", { name: /Pane 숨기기/ }).className,
    ).toContain("pr-2.5");
  });
});
