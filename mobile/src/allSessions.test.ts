import { describe, expect, it } from "vitest";
import {
  buildUnifiedListing,
  flattenRows,
  groupByProject,
  hubKnowing,
  mergeLayouts,
} from "./allSessions";
import type { CensusRow } from "./census";
import type { HubLayout, HubPlacement, HubProbeSession } from "./ipc";
import type { RemoteSession } from "./sessions";

function seat(desktop: string, project = "agent-ide", order = 0): HubPlacement {
  return { desktop, project, order };
}

function layout(
  placements: Record<string, HubPlacement>,
  desktopOrder: string[],
): HubLayout {
  return { placements, desktop_order: desktopOrder };
}

function remote(sessionId: string, overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: sessionId,
    session_name: null,
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

function hubSession(sessionId: string, overrides: Partial<HubProbeSession> = {}): HubProbeSession {
  return {
    ...remote(sessionId),
    launch_program: null,
    box_id: "this-laptop",
    box_label: "맥북",
    ...overrides,
  };
}

describe("mergeLayouts", () => {
  it("허브 id 순으로 합쳐서, 화면을 다시 그려도 같은 결과를 낸다", () => {
    const merged = mergeLayouts({
      "SHA256:b": layout({ "s-b": seat("Onchain") }, ["Onchain"]),
      "SHA256:a": layout({ "s-a": seat("Workspace") }, ["Workspace"]),
    });
    expect(merged.desktop_order).toEqual(["Workspace", "Onchain"]);
    expect(Object.keys(merged.placements).sort()).toEqual(["s-a", "s-b"]);
  });

  /** 두 노트북이 같은 서버 세션을 각자의 데스크탑에 놓을 수 있다. */
  it("같은 세션에 두 자리가 있으면 먼저 나온 허브가 이긴다", () => {
    const merged = mergeLayouts({
      "SHA256:b": layout({ "s-1": seat("Onchain") }, ["Onchain"]),
      "SHA256:a": layout({ "s-1": seat("Workspace") }, ["Workspace"]),
    });
    expect(merged.placements["s-1"].desktop).toBe("Workspace");
  });

  it("같은 이름의 데스크탑은 한 묶음이 된다", () => {
    const merged = mergeLayouts({
      "SHA256:a": layout({ "s-1": seat("Workspace") }, ["Workspace"]),
      "SHA256:b": layout({ "s-2": seat("Workspace") }, ["Workspace"]),
    });
    expect(merged.desktop_order).toEqual(["Workspace"]);
  });

  it("아무것도 없으면 빈 표다", () => {
    expect(mergeLayouts({})).toEqual({ placements: {}, desktop_order: [] });
  });
});

describe("buildUnifiedListing", () => {
  it("두 경로의 세션을 같은 데스크탑 아래에 세운다", () => {
    const { groups } = buildUnifiedListing({
      census: [censusRow("s-ssh")],
      hubs: [
        { hubId: "SHA256:a", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-hub")] },
      ],
      layout: layout(
        { "s-ssh": seat("Workspace", "Gate1", 1), "s-hub": seat("Workspace", "agent-ide", 0) },
        ["Workspace"],
      ),
    });

    expect(groups).toHaveLength(1);
    // 순서는 사이드바가 정한 자리 번호다 — 경로가 아니라.
    expect(groups[0].rows.map((row) => row.sessionId)).toEqual(["s-hub", "s-ssh"]);
    expect(groups[0].rows.map((row) => row.source.kind)).toEqual(["hub", "ssh"]);
  });

  /**
   * 이 시험이 사용자가 설계한 것의 핵심이다. 노트북을 끄면 그 컴퓨터의 로컬
   * 세션이 통째로 사라지는데(허브 카탈로그가 로컬만 나른다), 묶음은 그대로 서
   * 있고 서버 세션은 계속 열린다.
   */
  it("노트북이 꺼지면 그 줄은 사라지고 서버 줄은 남는다", () => {
    const table = layout(
      { "s-ssh": seat("Workspace", "Gate1", 1), "s-local": seat("Workspace", "agent-ide", 0) },
      ["Workspace"],
    );

    const { groups } = buildUnifiedListing({ census: [censusRow("s-ssh")], hubs: [], layout: table });

    expect(groups[0].rows.map((row) => row.sessionId)).toEqual(["s-ssh"]);
    expect(groups[0].label).toBe("Workspace");
  });

  /** 자리만 있고 아무것도 안 보이는 묶음도 머리글은 선다. */
  it("전부 못 닿는 묶음도 수를 노출하지 않고 남는다", () => {
    const { groups } = buildUnifiedListing({
      census: [],
      hubs: [],
      layout: layout({ "s-1": seat("Workspace"), "s-2": seat("Workspace") }, ["Workspace"]),
    });
    expect(groups.map((group) => [group.label, group.rows.length])).toEqual([["Workspace", 0]]);
  });

  /** 줄도 없고 못 닿는 것도 없으면 머리글만 남는다. */
  it("아무것도 없는 묶음은 아예 그리지 않는다", () => {
    const { groups } = buildUnifiedListing({
      census: [],
      hubs: [],
      layout: layout({}, ["Workspace"]),
    });
    expect(groups).toEqual([]);
  });

  it("같은 세션이 두 목록에 있으면 SSH 쪽을 쓴다", () => {
    const { groups } = buildUnifiedListing({
      census: [censusRow("s-1")],
      hubs: [
        { hubId: "SHA256:a", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-1")] },
      ],
      layout: layout({ "s-1": seat("Workspace") }, ["Workspace"]),
    });
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].source.kind).toBe("ssh");
  });

  it("SSH 서버가 끊겼어도 같은 세션의 허브 경로가 열리면 허브 쪽을 쓴다", () => {
    const input = {
      census: [censusRow("s-1", {}, false)],
      hubs: [
        { hubId: "SHA256:a", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-1")] },
      ],
      layout: layout({ "s-1": seat("Workspace") }, ["Workspace"]),
    };
    const { groups } = buildUnifiedListing(input);

    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].source).toMatchObject({ kind: "hub", reachable: true });
    expect(flattenRows(input)[0].source).toMatchObject({ kind: "hub", reachable: true });
  });

  it("노트북이 꺼지면 로컬 줄만 비활성이고 직접 SSH 중복은 계속 열린다", () => {
    const { groups } = buildUnifiedListing({
      census: [censusRow("s-remote")],
      hubs: [
        {
          hubId: "SHA256:a",
          hubLabel: "맥북",
          reachable: false,
          sessions: [hubSession("s-local"), hubSession("s-remote")],
        },
      ],
      layout: layout(
        { "s-local": seat("Workspace"), "s-remote": seat("Workspace", "Gate1", 1) },
        ["Workspace"],
      ),
    });

    const local = groups[0].rows.find((row) => row.sessionId === "s-local");
    const remote = groups[0].rows.find((row) => row.sessionId === "s-remote");
    expect(local?.source).toMatchObject({ kind: "hub", reachable: false });
    expect(remote?.source.kind).toBe("ssh");
  });

  /** 사이드바에 없는 세션은 그리지 않는다(소유자 결정). 수만 말한다. */
  it("자리가 없는 세션은 그리지 않고 세기만 한다", () => {
    const { groups, hidden } = buildUnifiedListing({
      census: [censusRow("s-1"), censusRow("s-없는것")],
      hubs: [],
      layout: layout({ "s-1": seat("Workspace") }, ["Workspace"]),
    });
    expect(groups[0].rows).toHaveLength(1);
    expect(hidden).toBe(1);
  });

  it("두 경로에 함께 있는 자리 없는 세션은 한 번만 센다", () => {
    const { groups, hidden } = buildUnifiedListing({
      census: [censusRow("s-1")],
      hubs: [
        { hubId: "SHA256:a", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-1")] },
      ],
      layout: layout({}, ["Workspace"]),
    });

    expect(groups).toEqual([]);
    expect(hidden).toBe(1);
  });

  /** 노트북 화면이 방금 지운 데스크탑이다. 폰이 되살릴 자리가 아니다. */
  it("순서에 없는 데스크탑의 자리는 줄로도 못-닿음으로도 세지 않는다", () => {
    const { groups, hidden } = buildUnifiedListing({
      census: [censusRow("s-1")],
      hubs: [],
      layout: layout({ "s-1": seat("지워진것"), "s-2": seat("지워진것") }, ["Workspace"]),
    });
    expect(groups).toEqual([]);
    expect(hidden).toBe(1);
  });

  it("실행 프로그램이 제공자를 이긴다", () => {
    const { groups } = buildUnifiedListing({
      census: [censusRow("s-1", { provider_id: "local-shell", launch_program: "ssh" })],
      hubs: [],
      layout: layout({ "s-1": seat("Workspace") }, ["Workspace"]),
    });
    expect(groups[0].rows[0].label).toBe("ssh");
  });

  /** 두 화면이 같은 상태를 다른 색으로 그리면 그건 취향이 아니라 사실이 어긋난 것이다. */
  it("상태 축은 SSH 경로와 같은 함수를 쓴다", () => {
    const { groups } = buildUnifiedListing({
      census: [censusRow("s-1", { lifecycle: "terminating", ready: false })],
      hubs: [],
      layout: layout({ "s-1": seat("Workspace") }, ["Workspace"]),
    });
    expect(groups[0].rows[0].state).toBe("unknown");
  });
});

describe("groupByProject", () => {
  const rows = (listing: ReturnType<typeof buildUnifiedListing>) => listing.groups[0].rows;

  it("keeps one heading per project, in placement order", () => {
    const listing = buildUnifiedListing({
      census: [censusRow("s-1"), censusRow("s-2"), censusRow("s-3")],
      hubs: [],
      layout: layout(
        {
          "s-1": seat("Workspace", "agent-ide", 0),
          "s-2": seat("Workspace", "Gate1", 1),
          "s-3": seat("Workspace", "agent-ide", 2),
        },
        ["Workspace"],
      ),
    });

    const projects = groupByProject(rows(listing));

    // Two headings, not three: the second agent-ide row joins the first group
    // rather than opening a repeat of a heading the sidebar shows once.
    expect(projects.map((project) => project.label)).toEqual(["agent-ide", "Gate1"]);
    expect(projects[0].rows.map((row) => row.sessionId)).toEqual(["s-1", "s-3"]);
  });

  /**
   * A heading named for something the user never created reads as a folder
   * they forgot making.
   */
  it("leaves rows with no project unlabelled instead of inventing a name", () => {
    const projects = groupByProject([
      {
        sessionId: "s-1",
        title: "s-1",
        state: "run",
        agent: "claude",
        label: "claude-code",
        project: "",
        order: 0,
        source: {
          kind: "ssh",
          serverId: "srv-1",
          serverLabel: "Gate1",
          reachable: true,
          session: remote("s-1"),
        },
      },
    ]);

    expect(projects).toHaveLength(1);
    expect(projects[0].label).toBe("");
  });
});

describe("hubKnowing", () => {
  /**
   * 이것이 "이 줄이 어느 목록에서 왔나" 와 달라야 하는 이유가 전부 여기 있다:
   * 같은 세션이 두 목록에 있으면 화면은 SSH 쪽 줄을 그린다. 그 줄로 소스
   * 컨트롤을 열었다고 해서, 그 세션을 아는 노트북이 없어지는 것은 아니다.
   */
  it("SSH 로 그려진 세션도 그것을 아는 허브를 찾아낸다", () => {
    const hubs = [
      { hubId: "SHA256:a", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-both")] },
    ];

    expect(hubKnowing(hubs, "s-both")).toBe("SHA256:a");
  });

  it("여러 컴퓨터 중 그 세션을 가진 쪽을 고른다", () => {
    const hubs = [
      { hubId: "SHA256:a", hubLabel: "맥북", reachable: true, sessions: [hubSession("s-1")] },
      { hubId: "SHA256:b", hubLabel: "미니", reachable: true, sessions: [hubSession("s-2")] },
    ];

    expect(hubKnowing(hubs, "s-2")).toBe("SHA256:b");
  });

  /** 아무도 모르면 없다. SSH 로만 닿는 상자가 그렇다. */
  it("아무 허브도 모르면 없다", () => {
    expect(hubKnowing([], "s-1")).toBeUndefined();
  });
});

/**
 * The row's title is the laptop's, whichever route drew the row.
 *
 * The SSH census only knows the hmux session name, and for an agent that is
 * the worktree slug — the phone was listing branches where the sidebar lists
 * conversation titles. The paired computer's listing carries the sidebar's
 * title, and `buildUnifiedListing` prefers the SSH route when both are open,
 * so without this the title depended on which cable answered first.
 */
describe("session titles", () => {
  const laptopTitle = "결제 API 리트라이 로직 수정";
  const hub = {
    hubId: "h1",
    hubLabel: "맥북",
    reachable: true,
    sessions: [hubSession("s-1", { session_name: laptopTitle })],
  };

  it("SSH 로 그려진 줄도 노트북이 사이드바에 쓰는 제목을 단다", () => {
    const listing = buildUnifiedListing({
      census: [censusRow("s-1", { session_name: "feat/mobile" })],
      hubs: [hub],
      layout: layout({ "s-1": seat("Workspace") }, ["Workspace"]),
    });
    const row = listing.groups[0].rows[0];
    expect(row.source.kind).toBe("ssh");
    expect(row.title).toBe(laptopTitle);
  });

  it("자리가 없는 평평한 목록에서도 같은 제목이다", () => {
    const rows = flattenRows({
      census: [censusRow("s-1", { session_name: "feat/mobile" })],
      hubs: [hub],
    });
    expect(rows.map((row) => row.title)).toEqual([laptopTitle]);
  });

  it("노트북이 그 세션을 모르면 hmux 이름이 남고, 그것도 없으면 id 다", () => {
    const rows = flattenRows({
      census: [
        censusRow("s-2", { session_name: "feat/mobile" }),
        censusRow("s-3", { session_name: null }),
      ],
      hubs: [{ ...hub, sessions: [] }],
    });
    expect(rows.map((row) => row.title).sort()).toEqual(["feat/mobile", "s-3"]);
  });
});
