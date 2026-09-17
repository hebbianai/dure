/**
 * The home screen, checked for what it refuses to say.
 *
 * The mockup carries numbers this phone has no source for — a per-row age and
 * a count of approvals waiting. Those absences are the point of most of these
 * tests: a screen that renders a plausible number is claiming to have measured
 * something it never asked about, and somebody decides on it.
 */

import { describe, expect, it, vi } from "vitest";
import type { CensusRow } from "./census";
import type { HubLayout, HubProbeSession } from "./ipc";
import type { RemoteSession } from "./sessions";
import { type CensusActions, type CensusModel, renderHomeScreen } from "./censusView";
import { t } from "./i18n";

const NOW = 1_700_000_000_000;

function remote(sessionId: string, overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: sessionId,
    session_name: sessionId,
    workspace_id: "workspace_1",
    session_class: "standalone",
    lifecycle: "ready",
    provider_id: "claude-code",
    runner_principal: "user",
    runner_instance: "i",
    channel_epoch: "e",
    host_instance_id: "h",
    terminal_epoch: "t",
    capabilities: [],
    ready: true,
    ...overrides,
  };
}

function censusRow(
  sessionId: string,
  overrides: Partial<RemoteSession> = {},
  reachable = true,
): CensusRow {
  return {
    serverId: "srv-1",
    serverLabel: "Gate1",
    reachable,
    session: remote(sessionId, overrides),
  };
}

function hubSession(sessionId: string, overrides: Partial<RemoteSession> = {}): HubProbeSession {
  return {
    ...remote(sessionId, overrides),
    launch_program: null,
    box_id: "this-laptop",
    box_label: "맥북",
  };
}

function layout(placements: HubLayout["placements"], order: string[]): HubLayout {
  return { placements, desktop_order: order };
}

const noActions: CensusActions = {
  open: () => {},
  selectDesktop: () => {},
  pair: () => {},
  settings: () => {},
  refresh: () => {},
  hold: () => {},
};

function model(overrides: Partial<CensusModel> = {}): CensusModel {
  return {
    census: [],
    hubs: [],
    layout: layout({}, []),
    failures: [],
    busy: false,
    emptyMessage: t("실행 중인 세션이 없습니다"),
    ...overrides,
  };
}

const ONE_DESKTOP = {
  census: [censusRow("s-1")],
  layout: layout({ "s-1": { desktop: "Workspace", project: "agent-ide", order: 0 } }, [
    "Workspace",
  ]),
};

describe("home header", () => {
  it.each(["flat", "grouped"])("hides unanswered-server cards in the %s home without removing sessions", (mode) => {
    const screen = renderHomeScreen(model({
      ...ONE_DESKTOP,
      ...(mode === "flat" ? { layout: layout({}, []) } : {}),
      failures: [{ serverId: "offline", serverLabel: "Offline server", message: "연결하지 못했습니다", detail: "connection refused" }],
    }), noActions);
    expect(screen.querySelector(".failures")).toBeNull();
    expect(screen.textContent).not.toContain(t("대답하지 못한 서버 {count}대", { count: 1 }));
    expect(screen.textContent).not.toContain("connection refused");
    expect(screen.querySelectorAll(".list__open")).toHaveLength(1);
  });

  /**
   * The hub catalog carries no timestamps and no pending approvals. The mockup
   * shows both; drawing either would be the screen counting something nobody
   * asked it to count.
   */
  it("prints no age and no pending count it was never given", () => {
    const text = renderHomeScreen(model(ONE_DESKTOP), noActions).textContent ?? "";

    for (const claim of ["대기", "8분", "waiting", "pending"]) {
      expect(text).not.toContain(claim);
    }
  });

  /**
   * The gesture that replaced the freshness button. It draws nothing until a
   * finger opens it, and the loader appears only for a census that is actually
   * running — a settled screen holding a `role="status"` loader would announce
   * a wait that is not happening.
   */
  it("keeps the pull strip shut and silent until a census runs", () => {
    const idle = renderHomeScreen(model(ONE_DESKTOP), noActions);
    expect(idle.querySelector(".home__pull")).not.toBeNull();
    expect(idle.querySelector(".home__pull .dure-loader")).toBeNull();

    const busy = renderHomeScreen(model({ ...ONE_DESKTOP, busy: true }), noActions);
    expect(busy.querySelector(".home__pull--busy .dure-loader")).not.toBeNull();
  });
});

describe("desktop tabs", () => {
  const TWO = {
    census: [censusRow("s-1"), censusRow("s-2")],
    layout: layout(
      {
        "s-1": { desktop: "Workspace", project: "agent-ide", order: 0 },
        "s-2": { desktop: "Onchain", project: "Gate1", order: 0 },
      },
      ["Workspace", "Onchain"],
    ),
    syncedAtMs: NOW,
  };

  it("shows one tab per desktop and only the selected one's rows", () => {
    const screen = renderHomeScreen(model(TWO), noActions);

    expect([...screen.querySelectorAll(".tab")].map((tab) => tab.textContent)).toEqual([
      "Workspace",
      "Onchain",
    ]);
    expect(screen.textContent).toContain("s-1");
    expect(screen.textContent).not.toContain("s-2");
  });

  const OFFLINE = {
    hubs: [{ hubId: "h1", hubLabel: "맥북", reachable: false, sessions: [hubSession("s-9")] }],
    layout: layout({ "s-9": { desktop: "Workspace", project: "agent-ide", order: 0 } }, [
      "Workspace",
    ]),
  };

  it("keeps an unreachable Hub row disabled without raising an error card", () => {
    const asked: string[] = [];
    const screen = renderHomeScreen(model(OFFLINE), {
      ...noActions,
      open: (source) => {
        asked.push(source.kind === "hub" ? source.hubLabel : source.serverLabel);
      },
    });

    // 물러나던 표시가 전부 사라졌다.
    expect(screen.querySelector(".project--offline")).toBeNull();
    expect(screen.querySelector(".project__state")).toBeNull();

    const row = screen.querySelector<HTMLButtonElement>(".list__open");
    expect(row?.disabled).toBe(true);
    expect(screen.querySelector(".list__note")).toBeNull();

    row?.click();
    expect(asked).toEqual([]);
  });

  it.each([OFFLINE, { census: [censusRow("s-1", {}, false)] }])(
    "does not open a menu from an unreachable row's long press",
    (offline) => {
      vi.useFakeTimers();
      try {
        const hold = vi.fn();
        const screen = renderHomeScreen(model(offline), { ...noActions, hold });
        screen.querySelector(".list__open")?.dispatchEvent(new Event("pointerdown"));
        vi.advanceTimersByTime(600);
        expect(hold).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  /**
   * 세션 자체가 아직 못 붙는 상태는 다른 사실이다. 잠시 뒤 다르게 답할 것이
   * 없으므로 물어볼 것도 없고, 그 줄은 예전처럼 자기 이유를 직접 말하고 눌리지
   * 않는다.
   */
  it("아직 못 붙는 세션은 예전처럼 자기 이유를 말하고 눌리지 않는다", () => {
    const own = renderHomeScreen(
      model({
        hubs: [
          {
            hubId: "h1",
            hubLabel: "맥북",
            reachable: true,
            sessions: [hubSession("s-9", { ready: false, lifecycle: "starting" })],
          },
        ],
        layout: layout({ "s-9": { desktop: "Workspace", project: "agent-ide", order: 0 } }, [
          "Workspace",
        ]),
      }),
      noActions,
    );
    expect(own.querySelector(".session-row--unattachable")?.textContent).toContain("starting");
    expect(own.querySelector<HTMLButtonElement>(".list__open")?.disabled).toBe(true);
  });

  it("disables an unreachable row even without a project heading", () => {
    const asked: string[] = [];
    const screen = renderHomeScreen(
      model({
        hubs: [
          { hubId: "h1", hubLabel: "맥북", reachable: false, sessions: [hubSession("s-9")] },
        ],
        // 프로젝트 이름이 빈 자리 — `groupByProject` 가 라벨 없는 묶음을 만든다.
        layout: layout({ "s-9": { desktop: "Workspace", project: "", order: 0 } }, ["Workspace"]),
      }),
      {
        ...noActions,
        open: (source) => {
          asked.push(source.kind === "hub" ? source.hubLabel : source.serverLabel);
        },
      },
    );

    expect(screen.querySelector(".project__header")).toBeNull();
    screen.querySelector<HTMLButtonElement>(".list__open")?.click();
    expect(screen.querySelector<HTMLButtonElement>(".list__open")?.disabled).toBe(true);
    expect(asked).toEqual([]);
  });

  /**
   * 끌기를 쓸 수 없는 사람에게도 다시 물어볼 길이 있어야 한다. VoiceOver 는 한
   * 손가락 끌기를 자기 탐색에 쓰므로, 제스처만 남기면 그 사람에게는 새로고침이
   * 아예 없는 것이 된다 — 없어진 동기화 줄은 초점을 받을 수 있었다.
   */
  it("끌기를 쓸 수 없어도 다시 확인할 수 있다", () => {
    let asked = 0;
    const screen = renderHomeScreen(model(ONE_DESKTOP), {
      ...noActions,
      refresh: () => {
        asked += 1;
      },
    });

    const again = screen.querySelector<HTMLButtonElement>(".home__refresh");
    expect(again?.textContent).toBe(t("다시 확인"));
    again?.click();
    expect(asked).toBe(1);

    // 이미 돌고 있으면 두 번째를 시작하지 않는다.
    const busy = renderHomeScreen(model({ ...ONE_DESKTOP, busy: true }), noActions);
    expect(busy.querySelector<HTMLButtonElement>(".home__refresh")?.disabled).toBe(true);
  });

  /** 닿는 기계는 물러나지 않는다 — 흐려진 목록은 그 자체로 주장이다. */
  /**
   * The other half of the same fact.
   *
   * A project belongs to a machine whether the phone reaches it through a
   * paired laptop or straight over SSH, so an SSH server that stopped
   * answering has to dim exactly like a laptop that is off. It used to fall
   * through instead: its rows were dropped by the census, the group could not
   * be drawn, and the screen ended on "이 묶음의 세션 N개는 지금 닿을 수
   * 없습니다 — 그 컴퓨터가 꺼져 있습니다" — a sentence that also blamed the
   * wrong machine, since the laptop may well have been on.
   */
  it("keeps unreachable SSH rows visible but disabled", () => {
    const screen = renderHomeScreen(
      model({
        census: [censusRow("s-1", {}, false), censusRow("s-2", {}, false)],
        layout: layout(
          {
            "s-1": { desktop: "Workspace", project: "agent-ide", order: 0 },
            "s-2": { desktop: "Workspace", project: "agent-ide", order: 1 },
          },
          ["Workspace"],
        ),
      }),
      noActions,
    );

    // The rows are on screen — that is the whole point of remembering them.
    expect(screen.textContent).toContain("s-1");
    expect(screen.textContent).toContain("s-2");
    expect(screen.querySelector(".project--offline")).toBeNull();
    for (const open of screen.querySelectorAll<HTMLButtonElement>(".list__open")) {
      expect(open.disabled).toBe(true);
    }
    // 여전히 묶음 아래 문장도, 세어 놓은 수도 없다.
    expect(screen.textContent).not.toContain("닿을 수 없습니다");
    expect(screen.textContent).not.toContain("표시하지 않습니다");
  });

  it("disables only the unreachable row in a mixed project", () => {
    const asked: { kind: string; label: string }[] = [];
    const screen = renderHomeScreen(
      model({
        census: [censusRow("s-1"), censusRow("s-2", {}, false)],
        layout: layout(
          {
            "s-1": { desktop: "Workspace", project: "agent-ide", order: 0 },
            "s-2": { desktop: "Workspace", project: "agent-ide", order: 1 },
          },
          ["Workspace"],
        ),
      }),
      {
        ...noActions,
        open: (source) => {
          asked.push(
            source.kind === "ssh"
              ? { kind: "ssh", label: source.serverLabel }
              : { kind: "hub", label: source.hubLabel },
          );
        },
      },
    );

    expect(screen.querySelector(".project--offline")).toBeNull();
    expect(screen.querySelector<HTMLButtonElement>(".list__open")?.disabled).toBe(false);
    const dead = [...screen.querySelectorAll<HTMLButtonElement>(".list__open")][1];
    expect(dead?.disabled).toBe(true);
    dead?.click();
    expect(asked).toEqual([]);
  });

  it("닿는 기계의 묶음은 그대로 둔다", () => {
    const screen = renderHomeScreen(model(TWO), noActions);
    expect(screen.querySelector(".project--offline")).toBeNull();
    expect(screen.querySelector(".project__state")).toBeNull();
  });

  it("draws the desktop that was chosen", () => {
    const screen = renderHomeScreen(model({ ...TWO, desktop: "Onchain" }), noActions);

    expect(screen.textContent).toContain("s-2");
  });

  /**
   * A name that is no longer in the listing — a desktop deleted on the laptop
   * while the phone held it selected — must not empty the screen. A tab bar
   * with nothing under it reads as a broken sync.
   */
  it("falls back to the first desktop when the chosen one is gone", () => {
    const screen = renderHomeScreen(model({ ...TWO, desktop: "Deleted" }), noActions);

    expect(screen.textContent).toContain("s-1");
    expect(screen.querySelector(".tab--on")?.textContent).toBe("Workspace");
  });

  /**
   * The row stands even with one desktop, and ends with the tab: the "+"
   * that used to close it paired a computer, which read as "add a tab"
   * (2026-09-15 승연). Pairing is under 설정 › 컴퓨터.
   */
  it("keeps the row for a single desktop, with nothing after the tab", () => {
    const screen = renderHomeScreen(model(ONE_DESKTOP), noActions);

    expect(screen.querySelectorAll(".tab")).toHaveLength(1);
    expect(screen.querySelector(".tabs__add")).toBeNull();
    expect(screen.querySelector(".tabs")?.lastElementChild?.classList.contains("tab")).toBe(true);
  });
});

describe("session row", () => {
  /**
   * The row's job is to say which agent is sitting there. Borrowing Claude's
   * mark for a Codex session would make it name the wrong one.
   */
  it("does not lend the Claude mark to another provider", () => {
    // 표식은 둘째 줄에 산다. 브랜치를 주어 그 줄을 세운다 — 한 기계짜리 묶음은
    // 이제 짧은 줄로 그려지고, 짧은 줄에는 둘째 줄이 없다.
    const branched = {
      ...ONE_DESKTOP,
      layout: layout(
        { "s-1": { desktop: "Workspace", project: "agent-ide", order: 0, branch: "main" } },
        ["Workspace"],
      ),
    };
    const claude = renderHomeScreen(model(branched), noActions);
    const codex = renderHomeScreen(
      model({
        ...branched,
        census: [censusRow("s-1", { provider_id: "codex-cli" })],
      }),
      noActions,
    );

    expect(claude.querySelector(".session-row__provider")).not.toBeNull();
    expect(codex.querySelector(".session-row__provider--claude")).toBeNull();
    expect(codex.querySelector(".session-row__provider--codex")).not.toBeNull();
  });

  /**
   * 3096:86209 은 이 자리에 worktree 경로를 그린다. 폰이 가진 그 사실은
   * 브랜치이고, 노트북이 말해 줬을 때만 있다 — 그래서 알 때는 브랜치가 이기고,
   * 모를 때는 위 시험이 지키는 머신이 그대로 남는다.
   */
  it("브랜치를 알면 그것을 그린다", () => {
    const screen = renderHomeScreen(
      model({
        hubs: [{ hubId: "h1", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-9")] }],
        layout: layout(
          {
            "s-9": {
              desktop: "Workspace",
              project: "agent-ide",
              order: 0,
              branch: "worktree/card-tokens",
            },
          },
          ["Workspace"],
        ),
      }),
      noActions,
    );

    expect(screen.querySelector(".session-row__mono")?.textContent).toBe(
      "worktree/card-tokens",
    );
  });

  /**
   * Greying a row out without a reason reads as a dead session or a stuck app,
   * and the person keeps pressing it. The reason is the heading the row
   * stands under, said once, and the lifecycle word on the row's own line
   * (2026-09-15 승연, 안 3) — not a sentence under every row.
   */
  it("gathers a row that cannot be opened under its own heading, and only then", () => {
    const open = renderHomeScreen(model(ONE_DESKTOP), noActions);
    expect(open.querySelector(".list__note")).toBeNull();
    expect(open.querySelector(".list__heading")).toBeNull();

    const shut = renderHomeScreen(
      model({
        ...ONE_DESKTOP,
        census: [censusRow("s-1", { ready: false, lifecycle: "starting" })],
      }),
      noActions,
    );
    expect(shut.querySelector<HTMLButtonElement>(".list__open")?.disabled).toBe(true);
    expect(shut.querySelector(".list__note")).toBeNull();
    expect(shut.querySelector(".list__heading")?.textContent).toContain(t("연결할 수 없음"));
    expect(shut.querySelector(".session-row--unattachable")?.textContent).toContain("starting");
  });
});

/**
 * Nothing to list — Figma 3096:86335.
 *
 * The mockup draws one sentence, "mac-studio.local에 연결됨.", and that sentence
 * asserts a computer answered and had nothing. This screen reaches five
 * different empty states and only one of them is that, so these tests pin which
 * one gets the mockup's sentence and which ones keep their own.
 */
describe("empty home", () => {
  const CONNECTED = {
    hubs: [{ hubId: "h1", hubLabel: "mac-studio.local", reachable: true, sessions: [] }],
  };

  it("names the computer that answered, and what to do next", () => {
    const screen = renderHomeScreen(model(CONNECTED), noActions);
    const text = screen.querySelector(".home__empty")?.textContent ?? "";

    expect(screen.querySelector(".home__empty-title")?.textContent).toBe(t("세션 없음"));
    expect(text).toContain(t("{hub}에 연결됨.", { hub: "mac-studio.local" }));
    expect(text).toContain(t("+를 눌러 에이전트를 시작하세요."));
    // The mark, not the six-dot loader: this screen has finished asking.
    expect(screen.querySelector(".home__empty-mark")).not.toBeNull();
    expect(screen.querySelector(".home__empty .dure-loader")).toBeNull();
  });

  /** A remembered desktop stays selectable without exposing stale row counts. */
  it("빈 채로 선 데스크탑은 답하지 않은 세션 수를 노출하지 않는다", () => {
    const screen = renderHomeScreen(
      model({
        census: [],
        hubs: [],
        layout: layout(
          {
            "s-1": { desktop: "Workspace", project: "agent-ide", order: 0 },
            "s-2": { desktop: "Workspace", project: "agent-ide", order: 1 },
          },
          ["Workspace"],
        ),
      }),
      noActions,
    );

    expect([...screen.querySelectorAll(".tab")].map((tab) => tab.textContent)).toEqual([
      "Workspace",
    ]);
    expect(screen.querySelector(".home__empty")).not.toBeNull();
    expect(screen.querySelector(".home__empty-title")?.textContent).toBe(t("세션 없음"));
    expect(screen.querySelector(".home__empty-body")?.textContent).toContain(
      t("실행 중인 세션이 없습니다"),
    );
  });

  /**
   * With no tab the strip does not stand — it was a lone "+" under the
   * wordmark (2026-09-15). Home is never reached with nothing paired, and
   * pairing another computer keeps its door under 설정 › 컴퓨터; the strip and
   * the strip comes back with the first tab.
   */
  it("hides the strip when there is no tab, and shows it for one desktop", () => {
    const empty = renderHomeScreen(model(CONNECTED), noActions);
    expect(empty.querySelectorAll(".tab")).toHaveLength(0);
    expect(empty.querySelector(".tabs")).toBeNull();
    const one = renderHomeScreen(model(ONE_DESKTOP), noActions);
    expect(one.querySelector(".tabs")).not.toBeNull();
  });

  /**
   * A census that lost a server did not succeed, and "연결됨" over it would be
   * the screen claiming a success it did not have, even without a failure card.
   */
  it("does not claim a connection when a server did not answer", () => {
    const screen = renderHomeScreen(
      model({
        ...CONNECTED,
        failures: [{ serverId: "srv-1", serverLabel: "Gate1", message: "연결하지 못했습니다" }],
        emptyMessage: t("대답한 서버가 없습니다 — 아래 이유를 확인하세요"),
      }),
      noActions,
    );
    const text = screen.querySelector(".home__empty")?.textContent ?? "";

    expect(text).not.toContain("mac-studio.local");
    expect(text).toContain(t("연결하지 못했습니다"));
    expect(screen.querySelector(".failures")).toBeNull();
  });

  /**
   * Two computers answered. Naming one of them hides the other, so the census's
   * own sentence stands instead.
   */
  it("names no computer when two answered", () => {
    const screen = renderHomeScreen(
      model({
        hubs: [
          { hubId: "h1", hubLabel: "mac-studio.local", reachable: true, sessions: [] },
          { hubId: "h2", hubLabel: "gate1", reachable: true, sessions: [] },
        ],
      }),
      noActions,
    );

    expect(screen.querySelector(".home__empty")?.textContent).not.toContain("mac-studio.local");
  });

  /**
   * The sessions are alive and merely unplaced. "세션 없음" over that reads as
   * every agent having died.
   */
  it("does not say there are no sessions when there are", () => {
    const screen = renderHomeScreen(
      model({
        hubs: [{ hubId: "h1", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-9")] }],
        layout: layout({}, ["Workspace"]),
      }),
      noActions,
    );

    expect(screen.querySelector(".home__empty-title")?.textContent).toBe(t("표시할 세션 없음"));
    expect(screen.querySelector(".home__empty")?.textContent).toContain("1");
  });
});
