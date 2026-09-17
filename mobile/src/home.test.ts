import { describe, expect, it } from "vitest";
import type { ServerReport } from "./census";
import { liveFirst, summarizeServers } from "./home";
import type { ServerRow } from "./ipc";
import type { RemoteSession } from "./sessions";

function server(overrides: Partial<ServerRow> = {}): ServerRow {
  return {
    id: "gate1",
    label: "Gate1",
    host: "192.0.2.10",
    port: 22,
    username: "gate1",
    host_key_fingerprint: "SHA256:abc",
    paired: true,
    attach_key_confinement: "forced_command",
    has_attach_key: true,
    has_list_key: false,
    ...overrides,
  } as ServerRow;
}

function session(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: "standalone_a",
    session_name: "feat/mobile-page",
    workspace_id: "workspace_ce4f",
    session_class: "standalone",
    lifecycle: "ready",
    provider_id: "claude-code",
    runner_principal: "local-user",
    runner_instance: "runner-1",
    channel_epoch: "1",
    host_instance_id: "host-1",
    terminal_epoch: "1",
    capabilities: [],
    ready: true,
    ...overrides,
  };
}

/**
 * 판별 필드는 `state`다 — `kind`가 아니다.
 *
 * `as ServerReport`로 캐스팅하지 않는 이유: 처음 이 픽스처를 `kind`로 썼고,
 * 캐스팅이 그 오타를 통과시켜 테스트가 구현이 아니라 제 착각을 검사했다.
 * 캐스팅 없이 쓰면 필드 이름이 틀린 순간 tsc가 잡는다.
 */
function listed(serverId: string, sessions: RemoteSession[]): ServerReport {
  return {
    server_id: serverId,
    server_label: serverId,
    outcome: { state: "listed", sessions },
  };
}

function refused(serverId: string): ServerReport {
  return {
    server_id: serverId,
    server_label: serverId,
    outcome: { state: "not_configured", code: "relay_identity_missing", detail: "키 없음" },
  };
}

describe("summarizeServers", () => {
  /**
   * 이게 이 함수에서 가장 중요한 구분이다. 아직 묻지 않은 서버를 "세션 없음"으로
   * 쓰면, 사용자는 서버가 비었다고 믿고 폰을 닫는다.
   */
  it("아직 묻지 않은 서버를 빈 서버로 말하지 않는다", () => {
    const [summary] = summarizeServers([server()], undefined);

    expect(summary?.detail).toMatch(/Checking|확인 중/);
    expect(summary?.detail).not.toMatch(/없음|No sessions/);
  });

  it("대답한 서버는 세션 수를 적는다", () => {
    const [summary] = summarizeServers(
      [server()],
      [listed("gate1", [session({ session_id: "a" }), session({ session_id: "b", lifecycle: "ended" })])],
    );

    expect(summary?.detail).toContain("2");
    expect(summary?.detail).toContain("1");
    expect(summary?.sessionCount).toBe(2);
    expect(summary?.reachable).toBe(true);
  });

  it("대답하지 못한 서버는 이유를 적고 닿지 않는다고 표시한다", () => {
    const [summary] = summarizeServers([server()], [refused("gate1")]);

    expect(summary?.reachable).toBe(false);
    expect(summary?.detail.length).toBeGreaterThan(0);
  });

  /** 서버가 목록에서 조용히 사라지면 없는 서버로 읽힌다. */
  it("대답하지 못한 서버도 목록에 남는다", () => {
    const summaries = summarizeServers(
      [server({ id: "gate1" }), server({ id: "clink", label: "Clink" })],
      [listed("gate1", [session()]), refused("clink")],
    );

    expect(summaries.length).toBe(2);
    expect(summaries.map((entry) => entry.server.id)).toEqual(["gate1", "clink"]);
  });

  /**
   * 조사는 돌았는데 그 안에 이 서버가 없는 경우. `not_attempted`가 실제 결과
   * 중 하나이고, 페어링 직후에는 서버 목록이 조사보다 새롭다. "세션 없음"이라고
   * 쓰면 사용자는 서버가 비었다고 믿고 폰을 닫는다.
   */
  it("조사에서 빠진 서버를 빈 서버로 말하지 않는다", () => {
    const [summary] = summarizeServers([server({ id: "gate1" })], [listed("clink", [session()])]);

    expect(summary?.detail).toMatch(/Checking|확인 중/);
    expect(summary?.detail).not.toMatch(/없음|No sessions/);
  });

  it("세션이 진짜로 없는 서버는 없다고 말한다", () => {
    const [summary] = summarizeServers([server()], [listed("gate1", [])]);
    expect(summary?.detail).toMatch(/No sessions|세션 없음/);
  });
});

describe("liveFirst", () => {
  it("실행 중인 세션이 종료된 것보다 앞에 온다", () => {
    const rows = liveFirst([
      { serverId: "a", serverLabel: "A", reachable: true, session: session({ session_id: "ended", lifecycle: "ended" }) },
      { serverId: "b", serverLabel: "B", reachable: true, session: session({ session_id: "run", lifecycle: "ready" }) },
    ]);

    expect(rows.map((row) => row.session.session_id)).toEqual(["run", "ended"]);
  });

  /**
   * 모르는 상태는 종료된 것보다 앞이다. 사용자가 확인해야 할 수도 있는 세션을
   * 목록 밑바닥에 묻지 않는다.
   */
  it("상태를 모르는 세션은 종료된 것보다 앞에 온다", () => {
    const rows = liveFirst([
      { serverId: "a", serverLabel: "A", reachable: true, session: session({ session_id: "ended", lifecycle: "ended" }) },
      { serverId: "b", serverLabel: "B", reachable: true, session: session({ session_id: "huh", lifecycle: "누구세요" }) },
    ]);

    expect(rows.map((row) => row.session.session_id)).toEqual(["huh", "ended"]);
  });

  it("같은 상태면 서버 이름 순이다", () => {
    const rows = liveFirst([
      { serverId: "z", serverLabel: "Zeta", reachable: true, session: session({ session_id: "z" }) },
      { serverId: "a", serverLabel: "Alpha", reachable: true, session: session({ session_id: "a" }) },
    ]);

    expect(rows.map((row) => row.serverLabel)).toEqual(["Alpha", "Zeta"]);
  });
});
