import { describe, expect, it } from "vitest";
import {
  agentKind,
  groupRows,
  matchesFilter,
  runState,
  summarize,
  toRow,
} from "./sessionRows";
import type { RemoteSession } from "./sessions";

function session(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: "standalone_f2ea6f03ac27",
    session_name: "feat/mobile-page",
    workspace_id: "workspace_ce4fda4853034472",
    session_class: "standalone",
    lifecycle: "ready",
    provider_id: "claude-code",
    runner_principal: "local-user",
    runner_instance: "runner-1",
    channel_epoch: "1",
    host_instance_id: "host-1",
    terminal_epoch: "1",
    capabilities: ["terminal_surface_v1"],
    ready: true,
    ...overrides,
  };
}

describe("runState", () => {
  it("종료된 세션과 살아 있는 세션을 다른 축으로 접는다", () => {
    expect(runState(session({ lifecycle: "ready" }))).toBe("run");
    expect(runState(session({ lifecycle: "starting" }))).toBe("warn");
    expect(runState(session({ lifecycle: "failed" }))).toBe("blocked");
    expect(runState(session({ lifecycle: "ended" }))).toBe("done");
  });

  it("대소문자와 공백에 흔들리지 않는다", () => {
    expect(runState(session({ lifecycle: " READY " }))).toBe("run");
  });

  /**
   * 이게 이 함수에서 가장 중요한 성질이다. 모르는 lifecycle을 초록으로 떨어뜨리면
   * 화면이 "실행 중"이라고 주장하고, 사람은 그 화면을 보고 판단한다. 새 상태가
   * 프로토콜에 생기는 날 이 테스트가 아니라 화면이 먼저 거짓말하게 두지 않는다.
   */
  it("모르는 lifecycle은 실행 중으로 위장하지 않는다", () => {
    expect(runState(session({ lifecycle: "quantum-superposition" }))).toBe("unknown");
    expect(runState(session({ lifecycle: "" }))).toBe("unknown");
  });
});

describe("agentKind", () => {
  it("접미사가 붙은 제공자 id도 알아본다", () => {
    expect(agentKind("claude-code")).toBe("claude");
    expect(agentKind("codex-cli")).toBe("codex");
    expect(agentKind("openai-responses")).toBe("codex");
    expect(agentKind("kimi-k2")).toBe("kimi");
  });

  /** 모르는 제공자를 claude 색으로 그리면 화면이 틀린 사실을 주장한다. */
  it("모르는 제공자는 알려진 에이전트를 사칭하지 않는다", () => {
    expect(agentKind("local-shell")).toBe("other");
    expect(agentKind("")).toBe("other");
  });
});

describe("toRow", () => {
  it("이름이 없으면 세션 id를 제목으로 쓴다", () => {
    const row = toRow(session({ session_name: null }));
    expect(row.title).toBe("standalone_f2ea6f03ac27");
  });

  it("모르는 제공자의 이름도 그대로 적는다", () => {
    const row = toRow(session({ provider_id: "local-shell" }));
    expect(row.agent).toBe("other");
    expect(row.provider).toBe("local-shell");
  });
});

describe("matchesFilter", () => {
  const live = toRow(session({ lifecycle: "ready" }));
  const starting = toRow(session({ lifecycle: "starting" }));
  const ended = toRow(session({ lifecycle: "ended" }));

  it("기본 필터는 아무것도 숨기지 않는다", () => {
    for (const row of [live, starting, ended]) {
      expect(matchesFilter(row, "all")).toBe(true);
    }
  });

  /** `ready`만 보면 시작 중인 세션이 '살아 있음'에서 빠진다. */
  it("시작 중인 세션도 살아 있는 쪽에 든다", () => {
    expect(matchesFilter(starting, "live")).toBe(true);
    expect(matchesFilter(ended, "live")).toBe(false);
  });

  it("종료 필터는 종료된 것만 남긴다", () => {
    expect(matchesFilter(ended, "ended")).toBe(true);
    expect(matchesFilter(live, "ended")).toBe(false);
  });
});

describe("groupRows", () => {
  /**
   * 데스크탑으로 묶는다. 클래스(managed/standalone)로 묶던 것을 바꾼 이유는
   * 이 시험이 그대로 보여준다: 같은 데스크탑에서 일하던 에이전트와 셸이 두
   * 그룹으로 갈라지고, 아무 상관없는 데스크탑의 셸들이 한 그룹에 뭉쳤다.
   */
  it("데스크탑으로 묶고 개수를 유지한다", () => {
    const groups = groupRows([
      toRow(session({ session_id: "a", workspace_id: "desk-1", session_class: "standalone" })),
      toRow(session({ session_id: "b", workspace_id: "desk-2", session_class: "managed" })),
      toRow(session({ session_id: "c", workspace_id: "desk-1", session_class: "managed" })),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["desk-1", "desk-2"]);
    expect(groups.find((group) => group.key === "desk-1")?.rows.length).toBe(2);
    expect(groups.flatMap((group) => group.rows).length).toBe(3);
  });

  /**
   * 행 안에서 지키는 규칙을 묶음 사이에서도 지킨다. 종료된 묶음이 위에 쌓이면
   * 붙을 수 있는 세션을 찾으려 스크롤해야 한다.
   */
  it("살아 있는 묶음이 먼저 온다", () => {
    const groups = groupRows([
      toRow(session({ session_id: "a", workspace_id: "aaa-ended", lifecycle: "ended" })),
      toRow(session({ session_id: "b", workspace_id: "zzz-live", lifecycle: "ready" })),
    ]);

    expect(groups[0]?.key).toBe("zzz-live");
  });

  it("데스크탑이 빈 세션도 묶음을 잃지 않는다", () => {
    const groups = groupRows([toRow(session({ workspace_id: "  " }))]);
    expect(groups[0]?.key).toBe("unknown");
    expect(groups[0]?.rows.length).toBe(1);
  });
});

/**
 * `summarize`는 `t()`를 지나므로 결과가 로케일에 달려 있다. jsdom의
 * `navigator.language`는 "en-US"라서 여기서는 영어가 나온다. 한국어 원문으로
 * 비교하면 시험이 번역 표에 묶이고, 번역 하나 고칠 때마다 깨지는 시험은 로직이
 * 깨진 것과 구별되지 않는다 — 그래서 개수와 뜻만 검사한다.
 */
describe("summarize", () => {
  it("세션이 없으면 없다고 말한다", () => {
    expect(summarize([])).toMatch(/No sessions|세션 없음/);
  });

  it("활성이 있으면 개수를 나눠 적는다", () => {
    const text = summarize([
      toRow(session({ session_id: "a", lifecycle: "ready" })),
      toRow(session({ session_id: "b", lifecycle: "ended" })),
    ]);
    expect(text).toContain("2");
    expect(text).toContain("1");
  });

  /**
   * 이 앱은 워크트리를 모른다. 세션 수를 워크트리 수라고 부르면 숫자는
   * 그럴듯하고 뜻은 틀리다 — 그런 문구를 만들지 않는다는 것을 못박는다.
   */
  it("세지 않은 것을 세었다고 하지 않는다", () => {
    const text = summarize([toRow(session())]);
    expect(text).not.toMatch(/워크트리|worktree|PR/);
  });
});

describe("무엇을 실행 중인지", () => {
  /**
   * 이 시험이 지키는 것: `ssh`로 띄운 세션과 그냥 셸이 목록에서 구분된다.
   *
   * 제공자로는 갈라지지 않는다 — `hmux new -- ssh host`로 만든 세션도 제공자는
   * 로컬 셸이라, 이 축이 없으면 두 줄이 글자 하나까지 같아 보인다.
   */
  it("띄워진 프로그램이 있으면 행에 실린다", () => {
    const row = toRow(session({ provider_id: "local-shell", launch_program: "ssh" }));

    expect(row.launchProgram).toBe("ssh");
    expect(row.provider).toBe("local-shell");
  });

  /**
   * 모를 때 자리를 비워두는 것이, 모르는 것을 "셸"이라고 단정하는 것보다 낫다.
   * 낡은 게이트웨이는 이 값을 보내지 않고, Host가 기록하지 못했을 수도 있다.
   */
  it("모르면 없는 채로 둔다 — 추측하지 않는다", () => {
    expect(toRow(session()).launchProgram).toBeUndefined();
    expect(toRow(session({ launch_program: null })).launchProgram).toBeUndefined();
  });
});
