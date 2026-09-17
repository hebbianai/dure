import { describe, expect, it } from "vitest";
import {
  groupHubRowsByDesktop,
  groupHubRowsByLayout,
  hubReach,
  hubTitle,
  sortHubs,
  toHubSessionRow,
  toHubSessionRows,
} from "./hubs";
import type { HubLayout, HubProbeSession, HubRow } from "./ipc";

function hub(overrides: Partial<HubRow> = {}): HubRow {
  return {
    id: "SHA256:aaa",
    box_label: "맥북",
    endpoint: "192.168.0.12:47821",
    relay_offered: true,
    ...overrides,
  };
}

function session(overrides: Partial<HubProbeSession> = {}): HubProbeSession {
  return {
    session_id: "s-1",
    session_name: "배선",
    workspace_id: "agent-ide",
    session_class: "standalone",
    provider_id: "claude-code",
    launch_program: null,
    lifecycle: "ready",
    runner_principal: "user",
    runner_instance: "runner-1",
    channel_epoch: "channel-1",
    host_instance_id: "host-1",
    terminal_epoch: "terminal-1",
    capabilities: [],
    ready: true,
    box_id: "this-laptop",
    box_label: "맥북",
    ...overrides,
  };
}

describe("hubTitle", () => {
  it("라벨을 쓴다", () => {
    expect(hubTitle(hub({ box_label: "맥북" }))).toBe("맥북");
  });

  /**
   * 지문으로 떨어지지 않는 것이 요점이다. `SHA256:…`는 사람이 자기 노트북을
   * 알아보는 데 쓸 수 없는 값이라, 그 줄은 목록에서 정체불명의 항목이 된다.
   */
  it("라벨이 비면 지문이 아니라 주소로 부른다", () => {
    const title = hubTitle(hub({ box_label: "   ", endpoint: "192.168.0.12:47821" }));
    expect(title).toBe("192.168.0.12:47821");
    expect(title).not.toContain("SHA256");
  });
});

describe("sortHubs", () => {
  it("이름순으로 정렬한다", () => {
    const sorted = sortHubs([hub({ box_label: "서버" }), hub({ box_label: "맥북" })]);
    expect(sorted.map((row) => row.box_label)).toEqual(["맥북", "서버"]);
  });

  /**
   * 같은 이름 둘이 화면을 다시 그릴 때마다 자리를 바꾸면, 사용자는 방금 본 줄을
   * 다시 찾아야 한다. 공장 기본 호스트명은 실제로 겹친다.
   */
  it("이름이 같으면 id로 순서를 확정한다", () => {
    const order = sortHubs([
      hub({ id: "SHA256:bbb", box_label: "맥북" }),
      hub({ id: "SHA256:aaa", box_label: "맥북" }),
    ]).map((row) => row.id);
    expect(order).toEqual(["SHA256:aaa", "SHA256:bbb"]);
  });
});

describe("hubReach", () => {
  it("릴레이가 있으면 밖에서도 된다고 말한다", () => {
    expect(hubReach(hub({ relay_offered: true }))).toBe("밖에서도 연결됩니다");
  });

  it("릴레이가 없으면 재페어링이 필요하다고 말한다", () => {
    expect(hubReach(hub({ relay_offered: false }))).toBe(
      "인터넷 릴레이가 없습니다 · 다시 페어링하세요",
    );
  });
});

describe("toHubSessionRow", () => {
	it("사이드바가 보낸 정확한 제목을 hmux 세션 이름보다 먼저 쓴다", () => {
		expect(toHubSessionRow(session({ session_name: "mobile" })).title).toBe("mobile");
	});
  it("이름이 없으면 세션 id를 자르지 않고 그대로 쓴다", () => {
    const row = toHubSessionRow(session({ session_name: null, session_id: "abcdef123456" }));
    expect(row.title).toBe("abcdef123456");
  });

  /**
   * 실행 프로그램이 제공자를 이긴다. `local-shell`은 "터미널입니다"라는 말이라
   * 목록에서 세션을 가르는 데 쓸모가 없고, `ssh`는 쓸모가 있다.
   */
  it("실행 프로그램을 알면 제공자 대신 그것을 적는다", () => {
    expect(toHubSessionRow(session({ provider_id: "local-shell", launch_program: "ssh" })).label).toBe(
      "ssh",
    );
    expect(toHubSessionRow(session({ provider_id: "claude-code", launch_program: null })).label).toBe(
      "claude-code",
    );
  });

  /**
   * SSH 경로와 같은 표를 쓴다는 것의 확인. 두 목록이 같은 세션을 다른 색으로
   * 그리면 그건 취향이 아니라 사실이 어긋난 것이다.
   */
  it("모르는 lifecycle을 실행 중으로 칠하지 않는다", () => {
    expect(toHubSessionRow(session({ lifecycle: "ready" })).state).toBe("run");
    expect(toHubSessionRow(session({ lifecycle: "terminating" })).state).toBe("unknown");
  });

  /** `ready`는 Rust가 계산한다. 화면이 `lifecycle`을 다시 해석하지 않는다. */
  it("붙을 수 있는지는 Rust가 준 값을 그대로 쓴다", () => {
    expect(toHubSessionRow(session({ lifecycle: "ready", ready: false })).ready).toBe(false);
  });
});

describe("toHubSessionRows", () => {
  /**
   * 허브 카탈로그는 상자·워크스페이스 순으로 온다. 종료된 세션이 위에 쌓이면
   * 폰에서는 살아 있는 세션을 찾으려고 스크롤해야 하고, 그 스크롤이 곧 목록을
   * 못 쓰게 만든다.
   */
  it("붙을 수 있는 세션을 앞으로 올린다", () => {
    const rows = toHubSessionRows([
      session({ session_id: "b", session_name: "끝난 것", lifecycle: "exited", ready: false }),
      session({ session_id: "a", session_name: "도는 것", lifecycle: "ready", ready: true }),
    ]);
    expect(rows.map((row) => row.title)).toEqual(["도는 것", "끝난 것"]);
  });

  it("같은 이름이면 세션 id로 순서를 확정한다", () => {
    const rows = toHubSessionRows([
      session({ session_id: "s-2", session_name: "같은 이름" }),
      session({ session_id: "s-1", session_name: "같은 이름" }),
    ]);
    expect(rows.map((row) => row.session.session_id)).toEqual(["s-1", "s-2"]);
  });
});

/** 사용자가 만든 데스크탑 구조를 아직 못 받았을 때의 대체 묶기. */
describe("groupHubRowsByDesktop", () => {
  it("상자별로 묶는다", () => {
    const groups = groupHubRowsByDesktop(
      toHubSessionRows([
        session({ session_id: "a", box_label: "맥북" }),
        session({ session_id: "b", box_label: "Gate1" }),
        session({ session_id: "c", box_label: "맥북" }),
      ]),
    );
    // 한국어 정렬이라 한글이 라틴보다 앞이다. 값 자체보다 **묶였다는 것**과
    // 순서가 화면을 다시 그려도 같다는 것이 여기서 고정하려는 것이다.
    expect(groups.map((group) => [group.label, group.rows.length])).toEqual([
      ["맥북", 2],
      ["Gate1", 1],
    ]);
  });

  /** 폰을 꺼낸 사람이 찾는 것은 지금 도는 것이다. */
  it("살아 있는 세션이 있는 데스크탑을 앞으로 올린다", () => {
    const groups = groupHubRowsByDesktop(
      toHubSessionRows([
        session({ session_id: "a", box_label: "가나다", lifecycle: "exited", ready: false }),
        session({ session_id: "b", box_label: "하하하", lifecycle: "ready", ready: true }),
      ]),
    );
    expect(groups.map((group) => group.label)).toEqual(["하하하", "가나다"]);
  });

  /** 이름 없는 상자를 빈 제목으로 두면 머리글이 사라진 것처럼 보인다. */
  it("이름이 없는 상자에도 부를 이름을 준다", () => {
    const groups = groupHubRowsByDesktop(toHubSessionRows([session({ box_label: "  " })]));
    expect(groups[0].label).toBe("이름 없는 컴퓨터");
  });
});

function layout(
  placements: HubLayout["placements"],
  desktopOrder: string[],
): HubLayout {
  return { placements, desktop_order: desktopOrder };
}

/**
 * 이 목록의 진짜 축. 사용자가 **노트북 앱에서 직접 만든** 데스크탑이고, 실제
 * 컴퓨터 기기가 아니다 — 사이드바가 그 순서로 서 있고, 폰이 다른 축으로 서면 같은
 * 세션을 두 화면에서 다른 자리에서 찾게 된다.
 */
describe("groupHubRowsByLayout", () => {
  it("사용자가 만든 데스크탑 이름으로 묶는다", () => {
    const { groups } = groupHubRowsByLayout(
      toHubSessionRows([session({ session_id: "a" }), session({ session_id: "b" })]),
      layout(
        {
          a: { desktop: "Workspace", project: "agent-ide", order: 0 },
          b: { desktop: "Onchain", project: "Gate1", order: 0 },
        },
        ["Workspace", "Onchain"],
      ),
    );

    expect(groups.map((group) => group.label)).toEqual(["Workspace", "Onchain"]);
    expect(groups[0].rows[0].session.session_id).toBe("a");
  });

  /**
   * 순서를 여기서 다시 만들지 않는다는 것. 살아 있는 것을 위로 올리는 식으로
   * 손대면 폰과 사이드바가 다른 순서로 서고, 그 차이는 두 화면을 나란히 보는
   * 사람에게만 보인다.
   */
  it("데스크탑 순서도 그 안의 순서도 사이드바가 정한다", () => {
    const { groups } = groupHubRowsByLayout(
      toHubSessionRows([
        session({ session_id: "a", lifecycle: "exited", ready: false }),
        session({ session_id: "b", lifecycle: "ready", ready: true }),
      ]),
      layout(
        {
          a: { desktop: "Onchain", project: "Gate1", order: 0 },
          b: { desktop: "Workspace", project: "agent-ide", order: 0 },
        },
        ["Onchain", "Workspace"],
      ),
    );
    // 살아 있는 세션이 아래 묶음에 있어도 순서는 그대로다.
    expect(groups.map((group) => group.label)).toEqual(["Onchain", "Workspace"]);
  });

  it("한 데스크탑 안에서는 사이드바의 자리 번호대로 선다", () => {
    const { groups } = groupHubRowsByLayout(
      toHubSessionRows([
        session({ session_id: "a", session_name: "먼저" }),
        session({ session_id: "b", session_name: "나중" }),
      ]),
      layout(
        {
          a: { desktop: "Workspace", project: "agent-ide", order: 1 },
          b: { desktop: "Workspace", project: "agent-ide", order: 0 },
        },
        ["Workspace"],
      ),
    );
    expect(groups[0].rows.map((row) => row.session.session_id)).toEqual(["b", "a"]);
  });

  /** 머리글을 두 겹으로 달지 않으려고 줄 안에 적는다. */
  it("프로젝트 이름을 줄에 붙인다", () => {
    const { groups } = groupHubRowsByLayout(
      toHubSessionRows([session({ session_id: "a" })]),
      layout({ a: { desktop: "Workspace", project: "agent-ide", order: 0 } }, ["Workspace"]),
    );
    expect(groups[0].rows[0].project).toBe("agent-ide");
  });

  /**
   * 사이드바에 없는 세션은 사용자가 정리한 적 없는 것이다. 그리지 않는 것이
   * 소유자 결정이고, 몇 개를 뺐는지는 화면이 한 줄로 말한다.
   */
  it("표에 없는 세션은 그리지 않고 세기만 한다", () => {
    const { groups, hidden } = groupHubRowsByLayout(
      toHubSessionRows([session({ session_id: "a" }), session({ session_id: "없는것" })]),
      layout({ a: { desktop: "Workspace", project: "agent-ide", order: 0 } }, ["Workspace"]),
    );
    expect(groups[0].rows.map((row) => row.session.session_id)).toEqual(["a"]);
    expect(hidden).toBe(1);
  });

  /** 노트북 화면이 방금 지운 데스크탑이다. 폰이 되살릴 자리가 아니다. */
  it("순서에 없는 데스크탑의 줄도 그리지 않고 센다", () => {
    const { groups, hidden } = groupHubRowsByLayout(
      toHubSessionRows([session({ session_id: "a" })]),
      layout({ a: { desktop: "지워진것", project: "agent-ide", order: 0 } }, ["Workspace"]),
    );
    expect(groups).toEqual([]);
    expect(hidden).toBe(1);
  });

  /** 빈 머리글이 서면 사용자는 세션이 사라졌다고 읽는다. */
  it("보일 줄이 없는 데스크탑은 머리글도 만들지 않는다", () => {
    const { groups } = groupHubRowsByLayout(
      toHubSessionRows([session({ session_id: "a" })]),
      layout({ a: { desktop: "Workspace", project: "agent-ide", order: 0 } }, [
        "Workspace",
        "빈것",
      ]),
    );
    expect(groups.map((group) => group.label)).toEqual(["Workspace"]);
  });
});
