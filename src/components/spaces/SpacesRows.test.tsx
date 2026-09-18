// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpacesVisibleField } from "@/lib/spaces/spacesViewOptions";
import type { Agent } from "@/types";
import { focusByKeyboard } from "@/test/keyboardFocus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@/lib/workspace/dock", () => ({
  openAgentPanelOnDesktop: vi.fn(),
  openSshTerminalPanelOnDesktop: vi.fn(),
  openTerminalPanelOnDesktop: vi.fn(),
}));
vi.mock("@/lib/agents/agentInstalls", () => ({
  useAvailableProviders: () => ["claude", "codex"],
}));

const providerHistoryMocks = vi.hoisted(() => ({
  loadRecord: vi.fn(),
  loadDetails: vi.fn(),
}));

vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
  loadProviderConversationRecord: providerHistoryMocks.loadRecord,
  loadProviderConversationDetails: providerHistoryMocks.loadDetails,
}));

import { OVERFLOW_REVEAL_DELAY_MS } from "@/components/ui/overflow-reveal-text";
import {
  OpenSpaceRow,
  UnopenedAgentRow,
  type SpaceMenuHandlers,
  type SpaceRowView,
} from "@/components/spaces/SpacesRows";
import {
  clearSpacesPaneHover,
  getSpacesPaneHover,
  spacesPaneHoverKey,
} from "@/lib/spaces/spacesPaneHover";
import { useStore } from "@/store";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import { publishConversationMetadata, publishConversationTitle } from "@/lib/agents/chat/conversationPresentationState";

afterEach(() => {
  cleanup();
  clearSpacesPaneHover();
  useStore.setState({ focusCtx: null, sessionActivity: {}, sessionTitle: {} });
  useDiffBadges.setState({ badges: {} });
  providerHistoryMocks.loadRecord.mockReset();
  providerHistoryMocks.loadDetails.mockReset();
  vi.clearAllMocks();
});

describe("OpenSpaceRow managed promotion", () => {
  const space = {
    key: "term:standalone-1",
    desktopId: "desktop-1",
    desktopName: "One",
    kind: "term",
    title: "Codex",
    detail: "로컬 · /repo",
    detailSource: "location",
    cwd: "/repo",
    projectId: undefined,
    projectName: "repo",
    relativePath: "/repo",
    branch: undefined,
    hostId: undefined,
    hostLabel: "로컬",
    hostBuild: "0.1.1+current",
    provider: "codex",
    managedPromotion: "eligible",
    displayState: "waiting",
    unread: false,
    agentId: undefined,
    activityAt: undefined,
  } satisfies SpaceRowView;

  function handlers(
    onPromoteManaged = vi.fn(),
  ): SpaceMenuHandlers {
    return {
      onViewDiff: vi.fn(),
      onMoveToDesktop: vi.fn(),
      onMoveToNewDesktop: vi.fn(),
      onRestart: vi.fn(),
      onFork: vi.fn(),
      onPromoteManaged,
      onSwitchAccount: vi.fn(),
      onKill: vi.fn(),
    };
  }

  function row(
    menuHandlers: SpaceMenuHandlers,
    nextSpace: SpaceRowView = space,
    visibleFields: readonly SpacesVisibleField[] = ["updated", "branch", "details", "gitStatus"],
    // Listed under a repository and a space heading, as most rows are;
    // false draws the row flat, as the pinned band does, where the row states
    // its space and its remoteness itself.
    listed = true,
  ) {
    return (
      <OpenSpaceRow
        space={nextSpace}
        visibleFields={visibleFields}
        groupBy={listed ? "repository" : undefined}
        spaceHeading={listed}
        showSpaces
        canViewDiff={false}
        isSelected={false}
        isContextTarget={false}
        selectionCount={1}
        promotionEligibleCount={
          nextSpace.managedPromotion === "eligible" ? 1 : 0
        }
        promotionDeferredCount={
          nextSpace.managedPromotion !== "hidden" &&
          nextSpace.managedPromotion !== "eligible"
            ? 1
            : 0
        }
        promotionBusy={false}
        onSpaceClick={vi.fn()}
        onContextMenuOpenChange={vi.fn()}
        onRowDragStart={vi.fn()}
        onRowDragEnd={vi.fn()}
        menuHandlers={menuHandlers}
      />
    );
  }

  it("shows relative activity time only while the pane is not working", () => {
    const nextSpace = { ...space, activityAt: Date.now() - 3 * 60_000 };
    const { rerender } = render(row(handlers(), nextSpace));
    expect(screen.getByText("3분 전")).toBeTruthy();
    rerender(row(handlers(), { ...nextSpace, displayState: "working" }));
    expect(screen.queryByText("3분 전")).toBeNull();
    rerender(row(handlers(), nextSpace));
    expect(screen.getByText("3분 전")).toBeTruthy();
  });

  it("keeps rows without activity silent — no time, no placeholder", () => {
    render(row(handlers()));
    expect(screen.queryByText(/전$/)).toBeNull();
  });

  it("keeps time on the title line without detail and on the metadata line with it", () => {
    const nextSpace = { ...space, activityAt: Date.now() - 3 * 60_000 };
    const { rerender } = render(row(handlers(), nextSpace, ["updated"]));
    const timeLine = () =>
      screen.getByText("3분 전").closest("[data-row-line]")?.getAttribute("data-row-line");
    expect(timeLine()).toBe("title");

    rerender(row(handlers(), nextSpace, ["updated", "details"]));
    expect(screen.getByText(space.detail)).toBeTruthy();
    expect(timeLine()).toBe("meta");

    rerender(row(handlers(), nextSpace, []));
    expect(screen.queryByText("3분 전")).toBeNull();
    expect(screen.queryByText(space.detail)).toBeNull();
  });

  it("stacks time under Git status at one trailing edge, outside the focus button", () => {
    // Inside the focus button the time stopped at the button's edge while the
    // badge sat beyond it, so the two read as unrelated (owner report 2026-09-06).
    useDiffBadges.setState({ badges: { "agent-trailing": {
      added: 1, deleted: 0, binary: 0, files: 2,
      committed: { added: 0, deleted: 0, binary: 0, files: 0 },
      worktree: { added: 1, deleted: 0, binary: 0, files: 2 },
      ahead: 0, behind: 1,
    } } });
    render(row(handlers(), {
      ...space, kind: "agent", agentId: "agent-trailing",
      detail: "terminal-parsing", activityAt: Date.now() - 8 * 60_000,
    }, ["updated", "details", "gitStatus"]));
    const time = screen.getByText("8분 전");
    const badge = screen.getByText("W2");
    const stack = time.closest('[data-slot="space-row-trailing"]');
    expect(stack).not.toBeNull();
    expect(stack?.contains(badge)).toBe(true);
    expect(badge.closest("[data-row-line]")?.getAttribute("data-row-line")).toBe("title");
    expect(time.closest("[data-row-line]")?.getAttribute("data-row-line")).toBe("meta");
    expect(screen.getByText("Codex").closest("button")?.contains(time)).toBe(false);
  });

  it("keeps a remote agent's Git counters as an indicator, not a diff launcher", () => {
    // The diff window reads a local worktree, so an SSH row must not offer it.
    useDiffBadges.setState({ badges: { "agent-remote": {
      added: 8, deleted: 3, binary: 0, files: 3,
      committed: { added: 0, deleted: 0, binary: 0, files: 0 },
      worktree: { added: 8, deleted: 3, binary: 0, files: 91 },
      ahead: 0, behind: 59,
    } } });
    const menuHandlers = handlers();
    render(row(menuHandlers, {
      ...space, kind: "agent", agentId: "agent-remote",
      hostId: "host-1", hostLabel: "build-box", detail: "terminal-parsing",
    }, ["updated", "details", "gitStatus"]));
    const badge = screen.getByText("W91");
    expect(badge.closest("button")).toBeNull();
    fireEvent.click(badge);
    expect(menuHandlers.onViewDiff).not.toHaveBeenCalled();
  });

  it("hides optional row metadata when Show is all off", () => {
    useDiffBadges.setState({ badges: { "agent-show": {
      added: 0, deleted: 0, binary: 0, files: 15,
      committed: { added: 0, deleted: 0, binary: 0, files: 0 },
      worktree: { added: 0, deleted: 0, binary: 0, files: 15 },
      ahead: 0, behind: 4,
    } } });
    render(row(handlers(), {
      ...space, kind: "agent", agentId: "agent-show",
      detail: "worktree/fix-live", managedPromotion: "hidden",
      activityAt: Date.now() - 3 * 60_000,
    }, []));
    expect(screen.queryByText("worktree/fix-live")).toBeNull();
    expect(screen.queryByText("W15")).toBeNull();
    expect(screen.queryByText("↓4")).toBeNull();
    expect(screen.queryByText("3분 전")).toBeNull();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("can show Details without Git status, then Git status without Details", () => {
    useDiffBadges.setState({ badges: { "agent-fields": {
      added: 1, deleted: 0, binary: 0, files: 15,
      committed: { added: 0, deleted: 0, binary: 0, files: 0 },
      worktree: { added: 1, deleted: 0, binary: 0, files: 15 },
      ahead: 0, behind: 4,
    } } });
    const nextSpace = { ...space, agentId: "agent-fields", detail: "worktree/fix-live" };
    const { rerender } = render(row(handlers(), nextSpace, ["details"]));
    expect(screen.getByText("worktree/fix-live")).toBeTruthy();
    expect(screen.queryByText("W15")).toBeNull();
    rerender(row(handlers(), nextSpace, ["gitStatus"]));
    expect(screen.queryByText("worktree/fix-live")).toBeNull();
    expect(screen.getByText("W15")).toBeTruthy();
    expect(screen.getByText("↓4")).toBeTruthy();
  });

  it("shows selected metadata fields and keeps unselected fields out", () => {
    render(
      row(
        handlers(),
        {
          ...space,
          desktopName: "Review",
          detail: "Fix the projection",
          branch: "agent/facets",
          hostLabel: "builder",
          hostId: "host-1",
        },
        ["environment", "branch", "machine", "details"],
        false,
      ),
    );
    // Flat, so the space ("Review") is stated; it is no field's to select.
    expect(
      screen.getByText(
        "SSH · Review · agent/facets · builder · Fix the projection",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/분 전$/)).toBeNull();
  });

  it("hides an ineligible shield until the row is hovered, keeping its slot", () => {
    render(
      row(handlers(), {
        ...space,
        managedPromotion: "working",
        displayState: "working",
      }),
    );
    const shield = screen.getByLabelText(
      "에이전트가 작업을 마치면 관리 세션으로 전환할 수 있습니다.",
    );
    // 자리는 남기고(레이아웃 불변) 평소에는 그리지 않는다 — 행 호버에서만.
    expect(shield.className).toContain("disabled:opacity-0");
    expect(shield.className).toContain(
      "group-hover/space-row:disabled:opacity-40",
    );
  });

  it("keeps an eligible shield always visible", () => {
    render(row(handlers()));
    const shield = screen.getByLabelText("관리 세션으로 전환");
    expect(shield.className).not.toContain("disabled:opacity-0");
  });

  it("shows an always-visible direct action and routes it without navigating", async () => {
    useStore.setState({ accounts: [], activeAccounts: {} });
    const onPromoteManaged = vi.fn();
    render(row(handlers(onPromoteManaged)));

    const promotion = screen.getByLabelText("관리 세션으로 전환");
    expect(promotion.getAttribute("title")).toBeNull();
    expect(promotion.getAttribute("data-slot")).toBe("tooltip-trigger");
    focusByKeyboard(promotion);
    expect(
      (await screen.findByText("관리 세션으로 전환")).getAttribute(
        "data-slot",
      ),
    ).toBe("tooltip-label");
    expect(
      (
        await screen.findByText(
          "Dure를 닫거나 다시 시작해도 세션이 계속 실행됩니다.",
        )
      ).getAttribute("data-slot"),
    ).toBe("tooltip-description");
    fireEvent.click(promotion);
    expect(onPromoteManaged).toHaveBeenCalledWith(space.key);
  });

  it("publishes its pane identity and clears hover on leave and unmount", () => {
    useStore.setState({ accounts: [], activeAccounts: {} });
    const { container, unmount } = render(row(handlers()));
    const target = container.querySelector(`[data-space-key="${space.key}"]`);
    expect(target).toBeTruthy();
    fireEvent.pointerEnter(target as Element);
    expect(getSpacesPaneHover()).toBe(
      spacesPaneHoverKey(space.desktopId, space.key),
    );

    fireEvent.pointerLeave(target as Element);
    expect(getSpacesPaneHover()).toBeNull();

    fireEvent.pointerEnter(target as Element);
    unmount();
    expect(getSpacesPaneHover()).toBeNull();
  });

  it("reveals only the clipped metadata suffix after a deliberate hover, then resets", () => {
    vi.useFakeTimers();
    try {
      const detail =
        "chat-pane · make the focused pane border glow a little darker";
      render(row(handlers(), { ...space, detail }));
      const text = screen.getByText(detail);
      const viewport = text.parentElement;
      expect(viewport).toBeTruthy();
      Object.defineProperty(viewport, "clientWidth", {
        configurable: true,
        value: 100,
      });
      Object.defineProperty(text, "scrollWidth", {
        configurable: true,
        value: 240,
      });

      fireEvent.pointerEnter(viewport as Element, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(OVERFLOW_REVEAL_DELAY_MS - 1));
      expect(text.style.transform).not.toContain("-140px");

      act(() => vi.advanceTimersByTime(1));
      expect(text.style.transform).toContain("-140px");

      fireEvent.pointerLeave(viewport as Element, { pointerType: "mouse" });
      expect(text.style.transform).not.toContain("-140px");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("marks the focused pane row with the selected tint, background only, and moves it with focus", () => {
    const secondSpace = { ...space, key: "term:standalone-2" };
    useStore.setState({
      activeSpaceId: space.desktopId,
      focusCtx: {
        key: space.key,
        cwd: "/repo",
        source: "local",
        label: "repo",
      },
    });
    const { container } = render(
      <>
        {row(handlers())}
        {row(handlers(), secondSpace)}
      </>,
    );
    const first = container.querySelector(`[data-space-key="${space.key}"]`);
    const second = container.querySelector(
      `[data-space-key="${secondSpace.key}"]`,
    );

    expect(first?.classList.contains("hover:bg-glass-tint-selected")).toBe(true);
    expect(first?.classList.contains("hover:inset-ring-1")).toBe(false);
    expect(first?.classList.contains("bg-glass-tint-selected")).toBe(true);
    expect(first?.classList.contains("focus-visible:inset-ring-1")).toBe(true);
    expect(first?.hasAttribute("data-pane-focused")).toBe(true);
    expect(second?.classList.contains("bg-glass-tint-selected")).toBe(false);

    act(() => {
      useStore.setState({
        focusCtx: {
          key: secondSpace.key,
          cwd: "/repo",
          source: "local",
          label: "repo",
        },
      });
    });

    expect(first?.classList.contains("bg-glass-tint-selected")).toBe(false);
    expect(first?.hasAttribute("data-pane-focused")).toBe(false);
    expect(second?.classList.contains("bg-glass-tint-selected")).toBe(true);
    expect(second?.hasAttribute("data-pane-focused")).toBe(true);
  });

  it("dims only the source row for the lifetime of a pane drag", () => {
    const { container } = render(row(handlers()));
    const target = container.querySelector(`[data-space-key="${space.key}"]`);
    expect(target).toBeTruthy();

    fireEvent.dragStart(target as Element, {
      dataTransfer: { setData: vi.fn(), effectAllowed: "none" },
    });
    expect(target?.hasAttribute("data-pane-dragging")).toBe(true);
    expect(target?.classList.contains("opacity-55")).toBe(true);

    fireEvent.dragEnd(target as Element);
    expect(target?.hasAttribute("data-pane-dragging")).toBe(false);
    expect(target?.classList.contains("opacity-55")).toBe(false);
  });

  it("wraps the diff action below the identity when the row container is narrow", () => {
    const agentId = "agent-narrow-diff";
    useDiffBadges.setState({
      badges: {
        [agentId]: {
          added: 24,
          deleted: 3,
          binary: 0,
          files: 2,
          committed: { added: 24, deleted: 3, binary: 0, files: 2 },
          worktree: { added: 0, deleted: 0, binary: 0, files: 0 },
          ahead: 1,
          behind: 4,
        },
      },
    });
    const { container } = render(
      row(handlers(), {
        ...space,
        agentId,
        managedPromotion: "hidden",
      }),
    );

    const target = container.querySelector(`[data-space-key="${space.key}"]`);
    const primaryAction = target?.querySelector("button");
    const badge = screen.getByRole("button", {
      name: "커밋된 작업 패치 2개 파일, 로컬 WIP 0개 파일, 브랜치 ↑1 ↓4 — 클릭해서 diff 보기",
    });

    expect(target?.className).toContain(
      "@max-[220px]/space-open-rows:flex-wrap",
    );
    expect(primaryAction?.className).toContain(
      "@max-[220px]/space-open-rows:basis-full",
    );
    // The badge wraps inside its trailing stack, which carries the wrap rule.
    expect(
      badge.closest('[data-slot="space-row-trailing"]')?.className,
    ).toContain("@max-[220px]/space-open-rows:ml-auto");
  });

  it("opens a move submenu listing target desktops and routes the move", async () => {
    const prevDesktops = useStore.getState().desktops;
    useStore.setState({
      desktops: [
        { id: "desktop-1", name: "One" },
        { id: "desktop-2", name: "Two" },
      ],
    } as never);
    try {
      const menuHandlers = handlers();
      const { container } = render(row(menuHandlers));
      fireEvent.contextMenu(
        container.querySelector(`[data-space-key="${space.key}"]`) as Element,
      );
      const subTrigger = await screen.findByRole("menuitem", {
        name: "데스크탑으로 이동",
      });
      subTrigger.focus();
      fireEvent.keyDown(subTrigger, { key: "ArrowRight" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Two" }));
      await waitFor(() =>
        expect(menuHandlers.onMoveToDesktop).toHaveBeenCalledWith(
          space.key,
          "desktop-2",
        ),
      );
      // 현재 데스크탑은 이동 대상이 아니다.
      expect(screen.queryByRole("menuitem", { name: "One" })).toBeNull();
    } finally {
      useStore.setState({ desktops: prevDesktops } as never);
    }
  });

  it("keeps a working pane visible but disabled with the defer reason", () => {
    useStore.setState({ accounts: [], activeAccounts: {} });
    render(
      row(handlers(), {
        ...space,
        managedPromotion: "working",
        displayState: "working",
      }),
    );

    expect(
      screen.getByLabelText(
        "에이전트가 작업을 마치면 관리 세션으로 전환할 수 있습니다.",
      ),
    ).toHaveProperty("disabled", true);
  });
});

describe("UnopenedAgentRow diff badge", () => {
  const agent: Agent = {
    id: "agent-diff",
    name: "Claude Code",
    provider: "claude",
    projectId: "project-1",
    worktreePath: "/repo/worktree",
    branch: "agent/diff",
    sessionId: "session-1",
    sessionKind: "pty",
  };

  it("uses the shared background-free Pi glyph in unopened rows", () => {
    const piAgent: Agent = {
      ...agent,
      id: "pi-agent",
      name: "pi-99",
      provider: "pi",
      sessionId: "pi-session",
    };
    const { container } = render(
      <UnopenedAgentRow
        remote={false}
        agent={piAgent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · agent/pi"
        onOpen={vi.fn()}
        onViewDiff={vi.fn()}
        onFork={vi.fn()}
        onHide={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    const row = container.querySelector(`[data-agent-id="${piAgent.id}"]`);
    expect(row?.querySelector("img")).toBeNull();
    expect(row?.querySelector('svg[viewBox="1 1 12 12"]')).toBeTruthy();
  });

  it("uses row click for details and resumes only from the explicit action", async () => {
    const onOpen = vi.fn();
    const recentAgent = {
      ...agent,
      comment: "Older checkpoint summary",
      commentUpdatedAt: Date.now() - 4 * 60_000,
    };
    useStore.setState({
      sessionActivity: {
        [agent.sessionId]: {
          text: "Newest prompt summary with full context",
          at: Date.now() - 3 * 60_000,
        },
      },
    });

    const { container } = render(
      <UnopenedAgentRow
        remote={false}
        agent={recentAgent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · Older checkpoint summary"
        onOpen={onOpen}
        onViewDiff={vi.fn()}
        onFork={vi.fn()}
        onHide={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    const primaryAction = container.querySelector(
      `[data-agent-id="${agent.id}"] > button`,
    );
    expect(primaryAction?.textContent).toContain(
      "Newest prompt summary with full context",
    );
    expect(primaryAction?.classList.contains("cursor-grab!")).toBe(true);
    expect(primaryAction?.classList.contains("active:cursor-grabbing!")).toBe(
      true,
    );
    expect(primaryAction?.textContent).not.toContain(
      "Older checkpoint summary",
    );
    expect(screen.getByText("3분 전")).toBeTruthy();
    // The row button is the one disclosure: no separate arrow button and no
    // leading chevron. The slot stays the provider glyph in every state and
    // the row folds from its own click, the same as the sessions card.
    expect(screen.queryByRole("button", { name: "세부 정보 보기" })).toBeNull();
    expect(primaryAction?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-agent-details]")).toBeNull();
    expect(container.querySelector("[data-unopened-row-chevron]")).toBeNull();

    fireEvent.click(primaryAction as Element);

    expect(primaryAction?.getAttribute("aria-expanded")).toBe("true");

    const details = container.querySelector("[data-agent-details]");
    expect(details?.textContent).toContain(
      "Newest prompt summary with full context",
    );
    expect(details?.textContent).not.toContain("Older checkpoint summary");
    expect(details?.textContent).toContain("응답 대기");
    expect(details?.textContent).toContain("Claude");
    expect(details?.textContent).toContain("repo");
    expect(details?.textContent).toContain("agent/diff");
    expect(details?.textContent).toContain("/repo/worktree");
    expect(details?.className).not.toContain("max-h-");
    const detailsScroll = details?.querySelector(
      "[data-agent-details-scroll]",
    );
    const detailsFooter = details?.querySelector(
      "[data-agent-details-footer]",
    );
    // No nested scroller any more: the card takes its own height and the
    // list scrolls (owner call 2026-09-14).
    expect(detailsScroll?.className).not.toContain("overflow-y-auto");
    expect(detailsScroll?.className).not.toContain("overscroll-contain");
    expect(primaryAction?.getAttribute("aria-expanded")).toBe("true");
    expect(onOpen).not.toHaveBeenCalled();

    const resume = screen.getByRole("button", { name: "이어서 재개" });
    expect(resume.getAttribute("data-slot")).toBe("button");
    expect(resume.querySelector("svg")).toBeTruthy();
    expect(detailsScroll?.contains(resume)).toBe(false);
    expect(detailsFooter?.contains(resume)).toBe(true);
    fireEvent.click(resume);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(recentAgent);

    // The same row click closes the details again.
    fireEvent.click(primaryAction as Element);
    expect(container.querySelector("[data-agent-details]")).toBeNull();
    expect(primaryAction?.getAttribute("aria-expanded")).toBe("false");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("updates an unopened title from the live session and provider thread", () => {
    const titledAgent: Agent = {
      ...agent,
      id: "agent-live-title",
      name: "agent-live-title",
      sessionId: "session-live-title",
      worktreePath: "/repo/agent-live-title",
      conversationId: "conversation-live-title",
    };
    useStore.setState({
      sessionTitle: {
        [titledAgent.sessionId]: "Terminal session title",
      },
    });
    render(
      <UnopenedAgentRow
        remote={false}
        agent={titledAgent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · agent/live-title"
        onOpen={vi.fn()}
        onViewDiff={vi.fn()}
        onFork={vi.fn()}
        onHide={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    expect(screen.getByText("Terminal session title")).toBeTruthy();
    act(() => {
      publishConversationTitle(titledAgent.id, "Provider thread title");
    });
    expect(screen.getByText("Provider thread title")).toBeTruthy();
    expect(screen.queryByText("Terminal session title")).toBeNull();
    act(() => {
      publishConversationMetadata(titledAgent.id, titledAgent.conversationId!, {
        title: "Provider thread title", activityAt: null,
        recentPrompts: ["Restore my prompt", "<task-notification><task-id>one</task-id></task-notification>"],
      });
    });
    expect(screen.getByText("repo · Restore my prompt")).toBeTruthy();
  });

  it("loads the exact provider history into the scrolling details body", async () => {
    const historyAgent: Agent = {
      ...agent,
      conversationId: "conversation-1",
      runtimeBinding: {
        schemaVersion: 1,
        runtime: "legacy_session_v1",
        source: "local",
        hostId: "local",
        sessionId: agent.sessionId,
      } as unknown as Agent["runtimeBinding"],
    };
    providerHistoryMocks.loadRecord.mockResolvedValue({
      provider: "claude",
      id: "conversation-1",
      cwd: "/repo/worktree",
      title: "Inspect the repository",
      mtime: 100,
      resumeCapability: "exact",
      executionLocation: "local",
      recentTurns: [
        { role: "user", text: "Inspect this repository read-only." },
        { role: "agent", text: "I found one concrete safeguard." },
      ],
      subagentCount: 1,
    });
    providerHistoryMocks.loadDetails.mockResolvedValue({
      subagents: [
        {
          id: "agent-explore",
          title: "Trace session handoff code",
          kind: "Explore",
          status: "completed",
          mtime: 99,
        },
      ],
      totalCount: 1,
    });

    const { container } = render(
      <UnopenedAgentRow
        remote={false}
        agent={historyAgent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · agent/diff"
        onOpen={vi.fn()}
        onViewDiff={vi.fn()}
        onFork={vi.fn()}
        onHide={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    fireEvent.click(
      container.querySelector(
        `[data-agent-id="${agent.id}"] > button`,
      ) as Element,
    );

    expect(
      await screen.findByText("Inspect this repository read-only."),
    ).toBeTruthy();
    expect(screen.getByText("I found one concrete safeguard.")).toBeTruthy();
    expect(await screen.findByText("Trace session handoff code")).toBeTruthy();
    expect(providerHistoryMocks.loadRecord).toHaveBeenCalledWith(
      {
        provider: "claude",
        conversationId: "conversation-1",
        executionLocation: "local",
      },
      [],
    );
    expect(providerHistoryMocks.loadDetails).toHaveBeenCalledWith(
      {
        provider: "claude",
        conversationId: "conversation-1",
        executionLocation: "local",
      },
      [],
    );

    const detailsScroll = container.querySelector(
      "[data-agent-details-scroll]",
    );
    const resume = screen.getByRole("button", { name: "이어서 재개" });
    expect(detailsScroll?.contains(resume)).toBe(false);
  });

  it("keeps the row highlighted while its context menu is open and resumes explicitly", async () => {
    const onOpen = vi.fn();
    const { container } = render(
      <UnopenedAgentRow
        remote={false}
        agent={agent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · agent/diff"
        onOpen={onOpen}
        onViewDiff={vi.fn()}
        onFork={vi.fn()}
        onHide={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    const row = container.querySelector<HTMLElement>(
      `[data-agent-id="${agent.id}"]`,
    );
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row as HTMLElement);

    expect(row?.getAttribute("data-state")).toBe("open");
    expect(row?.className).toContain(
      "data-[state=open]:bg-glass-tint-selected",
    );
    const resume = await screen.findByRole("menuitem", {
      name: "이어서 재개",
    });
    expect(resume.querySelector("svg")).toBeTruthy();
    fireEvent.click(resume);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(agent);
  });

  it("offers hide-from-list from the context menu without opening the agent", async () => {
    const onOpen = vi.fn();
    const onHide = vi.fn();
    const { container } = render(
      <UnopenedAgentRow
        remote={false}
        agent={agent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · agent/diff"
        onOpen={onOpen}
        onViewDiff={vi.fn()}
        onFork={vi.fn()}
        onHide={onHide}
        onKill={vi.fn()}
      />,
    );

    fireEvent.contextMenu(
      container.querySelector(`[data-agent-id="${agent.id}"]`) as Element,
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "목록에서 숨기기" }),
    );
    expect(onHide).toHaveBeenCalledOnce();
    expect(onHide).toHaveBeenCalledWith(agent);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the QA-visible ± badge in Spaces and opens diff without opening the agent", async () => {
    useDiffBadges.setState({
      badges: {
        [agent.id]: {
          added: 4,
          deleted: 2,
          binary: 1,
          files: 3,
          committed: { added: 3, deleted: 2, binary: 0, files: 2 },
          worktree: { added: 1, deleted: 0, binary: 1, files: 1 },
          ahead: 1,
          behind: 2,
        },
      },
    });
    const onOpen = vi.fn();
    const onViewDiff = vi.fn();

    render(
      <UnopenedAgentRow
        remote={false}
        agent={agent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · agent/diff"
        onOpen={onOpen}
        onViewDiff={onViewDiff}
        onFork={vi.fn()}
        onHide={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    const badge = screen.getByRole("button", {
      name: "커밋된 작업 패치 2개 파일, 로컬 WIP 1개 파일, 브랜치 ↑1 ↓2 — 클릭해서 diff 보기",
    });
    expect(badge.getAttribute("title")).toBeNull();
    expect(badge.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(badge.textContent?.replace(/\s+/g, "")).toBe("C2W1↑1↓2");
    focusByKeyboard(badge);
    expect(
      (await screen.findByText("변경 내용")).getAttribute("data-slot"),
    ).toBe("tooltip-label");
    expect(
      (
        await screen.findByText(
          "커밋된 작업 패치 2개 파일, 로컬 WIP 1개 파일, 브랜치 ↑1 ↓2 — 클릭해서 diff 보기",
        )
      ).getAttribute("data-slot"),
    ).toBe("tooltip-description");
    fireEvent.click(badge);
    expect(onViewDiff).toHaveBeenCalledWith(agent);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows upstream-only drift without offering an empty diff action", () => {
    useDiffBadges.setState({
      badges: {
        [agent.id]: {
          added: 0,
          deleted: 0,
          binary: 0,
          files: 0,
          committed: { added: 0, deleted: 0, binary: 0, files: 0 },
          worktree: { added: 0, deleted: 0, binary: 0, files: 0 },
          ahead: 0,
          behind: 6,
        },
      },
    });

    render(
      <UnopenedAgentRow
        remote={false}
        agent={agent}
        displayState="waiting"
        unread={false}
        projectName="repo"
        detail="repo · agent/diff"
        onOpen={vi.fn()}
        onViewDiff={vi.fn()}
        onFork={vi.fn()}
        onHide={vi.fn()}
        onKill={vi.fn()}
      />,
    );

    const drift = screen.getByLabelText("로컬 작업 패치 없음, 브랜치 ↓6");
    expect(drift.tagName).toBe("SPAN");
    expect(drift.getAttribute("title")).toBeNull();
    expect(drift.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(drift.getAttribute("role")).toBe("img");
    expect(drift.textContent).toBe("↓6");
  });
});
