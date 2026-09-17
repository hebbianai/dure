import { describe, expect, it } from "vitest";
import { buildSpaceMenu, type SpaceMenuEntry } from "@/lib/spaces/spacesActions";

const ids = (entries: SpaceMenuEntry[]) => entries.map((entry) => entry.id);

describe("buildSpaceMenu", () => {
  it("단일 선택에는 제목 줄이 없다 — 우클릭한 행이 이미 하이라이트돼 있다", () => {
    const entries = buildSpaceMenu({ count: 1 });
    expect(ids(entries)).toEqual(["move-new", "sep-kill", "kill"]);
    // 이동할 다른 데스크탑 정보가 없으면 대상별 항목도 없다.
    expect(ids(entries).some((id) => id.startsWith("move-to:"))).toBe(false);
  });

  it("데스크탑 이동을 서브메뉴로 낸다 — 현재·popout 제외, 맨 아래 새 데스크탑", () => {
    const entries = buildSpaceMenu({
      count: 1,
      currentDesktopId: "d1",
      desktops: [
        { id: "d1", name: "One" },
        { id: "d2", name: "Two" },
        { id: "d3", name: "Pop", kind: "popout" },
        { id: "d4", name: "Four" },
      ],
    });
    const move = entries.find((entry) => entry.id === "move");
    expect(move?.kind).toBe("submenu");
    const sub = move?.kind === "submenu" ? move.entries : [];
    expect(sub.map((entry) => entry.id)).toEqual([
      "move-to:d2",
      "move-to:d4",
      "sep-move-new",
      "move-new",
    ]);
    const toD2 = sub[0];
    expect(toD2?.kind === "item" && toD2.label).toBe("Two");
    expect(toD2?.kind === "item" && toD2.action).toEqual({
      type: "move-to-desktop",
      desktopId: "d2",
    });
    // 평면 '새 데스크탑으로 이동' 항목은 서브메뉴로 흡수된다.
    expect(ids(entries)).not.toContain("move-new");
  });

  it("이동할 다른 데스크탑이 없으면 평면 '새 데스크탑으로 이동'만 남는다", () => {
    const entries = buildSpaceMenu({
      count: 1,
      currentDesktopId: "d1",
      desktops: [
        { id: "d1", name: "One" },
        { id: "p", name: "Pop", kind: "popout" },
      ],
    });
    expect(ids(entries)).toContain("move-new");
    expect(entries.some((entry) => entry.kind === "submenu")).toBe(false);
  });

  it("다중 선택에서도 이동 서브메뉴가 나온다 — 선택 전체가 드래그와 같은 의미로 움직인다", () => {
    const entries = buildSpaceMenu({
      count: 3,
      currentDesktopId: "d1",
      desktops: [
        { id: "d1", name: "One" },
        { id: "d2", name: "Two" },
      ],
    });
    expect(ids(entries)).toContain("move");
  });

  it("다중 선택에는 몇 개인지 먼저 보여준다 — 마지막 항목이 파괴적이다", () => {
    const entries = buildSpaceMenu({ count: 3 });
    const header = entries[0];
    expect(header.id).toBe("header");
    const kill = entries[entries.length - 1];
    expect(header.kind === "label" && header.label).toContain("3");
    expect(kill?.kind === "item" && kill.label).toContain("3");
    expect(kill?.kind === "item" && kill.variant).toBe("destructive");
  });

  it("offers view-diff for one reviewable local session", () => {
    const agentSingle = buildSpaceMenu({
      count: 1,
      canViewDiff: true,
    });
    expect(ids(agentSingle)).toContain("view-diff");

    // 다중선택: diff 없음 (단일 worktree 리뷰 의미가 없다)
    const agentMulti = buildSpaceMenu({
      count: 2,
      canViewDiff: true,
    });
    expect(ids(agentMulti)).not.toContain("view-diff");

    // 로컬 cwd를 가진 standalone terminal도 같은 액션을 받는다.
    const localTerm = buildSpaceMenu({
      count: 1,
      canViewDiff: true,
    });
    expect(ids(localTerm)).toContain("view-diff");

    const unavailable = buildSpaceMenu({ count: 1 });
    expect(ids(unavailable)).not.toContain("view-diff");
  });

  it("프로바이더가 도는 행이면 터미널에도 재시작이 붙는다", () => {
    // 사용자에겐 Claude를 띄운 터미널도 에이전트로 보인다 — 등록 여부로
    // 가르면 화면에 로고가 붙어 있는데 메뉴만 다른 꼴이 된다.
    expect(ids(buildSpaceMenu({ count: 1 }))).not.toContain("restart");
    expect(
      ids(buildSpaceMenu({ count: 1, hasProvider: true })),
    ).toContain("restart");
    expect(
      ids(buildSpaceMenu({ count: 1, isAgent: true, hasProvider: true })),
    ).toContain("restart");
    // 다중선택에서는 뺀다: 여러 대화를 한 번에 되살리는 건 다른 의미다.
    expect(
      ids(buildSpaceMenu({ count: 2, hasProvider: true })),
    ).not.toContain("restart");
  });

  it("등록 에이전트 한 개에는 프로젝트 목록 없이 세션 포크를 제공한다", () => {
    const entries = buildSpaceMenu({
      count: 1,
      isAgent: true,
      provider: "claude",
      forkProviders: ["claude", "codex"],
    });
    expect(ids(entries)).toContain("fork:claude");
    expect(ids(entries)).toContain("fork:codex");

    const codexFork = entries.find((entry) => entry.id === "fork:codex");
    expect(
      codexFork?.kind === "item" &&
        codexFork.action.type === "fork" &&
        codexFork.action.provider,
    ).toBe("codex");
    expect(codexFork?.kind === "item" && codexFork.label).toContain("새 대화");

    const codexSourceEntries = buildSpaceMenu({
      count: 1,
      isAgent: true,
      provider: "codex",
      forkProviders: ["codex"],
    });
    const codexSameProviderFork = codexSourceEntries.find(
      (entry) => entry.id === "fork:codex",
    );
    expect(
      codexSameProviderFork?.kind === "item" && codexSameProviderFork.label,
    ).toContain("대화 포크");

    expect(
      ids(buildSpaceMenu({
        count: 1,
        provider: "claude",
        forkProviders: ["claude", "codex"],
      })),
    ).not.toContain("fork:claude");
    expect(
      ids(buildSpaceMenu({
        count: 2,
        isAgent: true,
        provider: "claude",
        forkProviders: ["claude", "codex"],
      })),
    ).not.toContain("fork:claude");
  });

  it("standalone managed 승격은 eligible일 때만 활성화하고 defer 이유를 보인다", () => {
    const eligible = buildSpaceMenu({
      count: 1,
      hasProvider: true,
      provider: "codex",
      managedPromotion: "eligible",
    });
    const action = eligible.find((entry) => entry.id === "promote-managed");
    expect(action?.kind === "item" && action.disabled).toBe(false);
    expect(action?.kind === "item" && action.label).toBe(
      "관리 세션으로 전환",
    );

    const working = buildSpaceMenu({
      count: 1,
      hasProvider: true,
      provider: "codex",
      managedPromotion: "working",
    });
    const deferred = working.find((entry) => entry.id === "promote-managed");
    expect(deferred?.kind === "item" && deferred.disabled).toBe(true);
    expect(deferred?.kind === "item" && deferred.label).toContain("작업을 마치면");

    const multi = buildSpaceMenu({
      count: 3,
      managedPromotionEligibleCount: 2,
      managedPromotionDeferredCount: 1,
    });
    const multiAction = multi.find(
      (entry) => entry.id === "promote-managed",
    );
    expect(
      multiAction?.kind === "item" && multiAction.label,
    ).toBe("2개를 관리 세션으로 전환");
    expect(
      multiAction?.kind === "item" && multiAction.disabled,
    ).toBe(false);

    const allDeferred = buildSpaceMenu({
      count: 2,
      managedPromotionDeferredCount: 2,
    }).find((entry) => entry.id === "promote-managed");
    expect(
      allDeferred?.kind === "item" && allDeferred.disabled,
    ).toBe(true);
  });

  it("계정이 둘 이상일 때만 계정 전환 절을 낸다", () => {
    const one = buildSpaceMenu({
      count: 1,
      hasProvider: true,
      accounts: [{ id: null, name: "기본", active: true }],
    });
    // 고를 게 하나뿐이면 절 자체가 의미 없다.
    expect(ids(one)).not.toContain("accounts-title");

    const many = buildSpaceMenu({
      count: 1,
      hasProvider: true,
      accounts: [
        { id: null, name: "기본", active: false },
        { id: "a1", name: "Personal", active: true },
      ],
    });
    expect(ids(many)).toContain("accounts-title");
    const personal = many.find((e) => e.id === "account:a1");
    expect(personal?.kind === "item" && personal.checked).toBe(true);
    expect(
      personal?.kind === "item" &&
        personal.action.type === "switch-account" &&
        personal.action.accountId,
    ).toBe("a1");
    // 안 고른 줄은 체크가 없다 — 렌더가 자리만 비워 글자 시작점을 맞춘다.
    const fallback = many.find((e) => e.id === "account:default");
    expect(fallback?.kind === "item" && fallback.checked).toBe(false);
  });

  it("에이전트는 '삭제', 터미널은 '종료'로 마지막 항목 문구가 갈린다", () => {
    // 에이전트 제거는 세션만 끊는 게 아니라 워크트리·등록까지 정리된다.
    const agent = buildSpaceMenu({ count: 1, isAgent: true });
    const term = buildSpaceMenu({ count: 1 });
    const lastLabel = (es: SpaceMenuEntry[]) => {
      const last = es[es.length - 1];
      return last.kind === "item" ? last.label : "";
    };
    expect(lastLabel(agent)).toContain("삭제");
    expect(lastLabel(term)).toContain("종료");
  });
});
