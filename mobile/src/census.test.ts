import { describe, expect, it } from "vitest";
import {
  type ProbeOutcome,
  type ServerReport,
  answeredCount,
  describeFailure,
  emptyMessage,
  failures,
  mergeSessions,
  rememberListings,
} from "./census";
import type { RemoteSession } from "./sessions";

function session(id: string, overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: id,
    session_name: null,
    workspace_id: "ws-1",
    session_class: "standalone",
    lifecycle: "ready",
    provider_id: "claude",
    runner_principal: "kattpish",
    runner_instance: "run-1",
    channel_epoch: "1",
    host_instance_id: "host-1",
    terminal_epoch: "term-1",
    capabilities: [],
    ready: true,
    ...overrides,
  };
}

function report(id: string, label: string, outcome: ProbeOutcome): ServerReport {
  return { server_id: id, server_label: label, outcome };
}

describe("mergeSessions", () => {
  it("모든 서버의 세션을 서버 이름표와 함께 한 목록으로 합친다", () => {
    const rows = mergeSessions([
      report("a", "가 서버", { state: "listed", sessions: [session("s1")] }),
      report("b", "나 서버", { state: "listed", sessions: [session("s2")] }),
    ]);

    expect(rows.map((row) => [row.serverLabel, row.session.session_id])).toEqual([
      ["가 서버", "s1"],
      ["나 서버", "s2"],
    ]);
  });

  /** 붙을 수 없는 세션이 위에 쌓이면 살아 있는 세션을 찾으려 스크롤해야 한다. */
  it("붙을 수 있는 세션을 먼저 올린다", () => {
    const rows = mergeSessions([
      report("a", "가 서버", {
        state: "listed",
        sessions: [session("dead", { ready: false, lifecycle: "terminating" })],
      }),
      report("b", "나 서버", { state: "listed", sessions: [session("live")] }),
    ]);

    expect(rows.map((row) => row.session.session_id)).toEqual(["live", "dead"]);
  });

  /**
   * 이 모듈이 존재하는 이유. 실패한 서버가 세션을 하나도 기여하지 않는 것과,
   * 실패가 조용히 "세션 없음"으로 읽히는 것은 다르다.
   */
  it("실패한 서버는 세션을 기여하지 않는다", () => {
    const rows = mergeSessions([
      report("a", "가 서버", { state: "not_provisioned", detail: "hmux: not found" }),
      report("b", "나 서버", { state: "listed", sessions: [session("live")] }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].serverId).toBe("b");
  });

  it("서버가 하나도 대답하지 않으면 빈 목록이다", () => {
    expect(mergeSessions([report("a", "가", { state: "not_attempted" })])).toEqual([]);
  });
});

/**
 * A server that stops answering must not take its projects off the screen.
 *
 * The paired-computer path has always kept the last catalog and flipped a flag;
 * the SSH path dropped the rows, so the home screen had nothing left to draw
 * and fell back to counting them in a sentence. 3096:86209 draws those sessions
 * — dimmed, under their own project heading — so the rows have to survive.
 */
describe("rememberListings", () => {
  const LISTED = report("a", "가 서버", { state: "listed", sessions: [session("s1")] });
  const SILENT = report("a", "가 서버", { state: "timed_out", seconds: 12 });

  it("keeps a silent server's last sessions, marked unreachable", () => {
    const remembered = rememberListings({}, [LISTED]);
    const rows = mergeSessions([SILENT], remembered);

    expect(rows).toHaveLength(1);
    expect(rows[0].session.session_id).toBe("s1");
    expect(rows[0].reachable).toBe(false);
  });

  it("marks a server that did answer reachable", () => {
    const rows = mergeSessions([LISTED], rememberListings({}, [LISTED]));
    expect(rows[0].reachable).toBe(true);
  });

  /**
   * Remembering is not the same as inventing. A server nobody has heard from
   * yet has no listing to fall back on, and a row drawn for it would be a
   * session the phone made up.
   */
  it("invents nothing for a server that has never answered", () => {
    expect(mergeSessions([SILENT], rememberListings({}, []))).toEqual([]);
  });

  it("replaces the memory when the server answers again", () => {
    const first = rememberListings({}, [LISTED]);
    const second = rememberListings(first, [
      report("a", "가 서버", { state: "listed", sessions: [session("s2")] }),
    ]);

    expect(mergeSessions([SILENT], second).map((row) => row.session.session_id)).toEqual(["s2"]);
  });

  /** A silent server's rows sort with the ones nobody can attach to. */
  it("sorts unreachable rows behind the live ones", () => {
    const rows = mergeSessions(
      [SILENT, report("b", "나 서버", { state: "listed", sessions: [session("live")] })],
      rememberListings({}, [LISTED]),
    );

    expect(rows.map((row) => row.session.session_id)).toEqual(["live", "s1"]);
  });
});

describe("failures", () => {
  it("대답하지 못한 서버를 전부, 이름과 함께 내놓는다", () => {
    const reported = failures([
      report("a", "가 서버", { state: "listed", sessions: [] }),
      report("b", "나 서버", { state: "timed_out", seconds: 12 }),
      report("c", "다 서버", { state: "not_attempted" }),
    ]);

    expect(reported.map((failure) => failure.serverLabel)).toEqual(["나 서버", "다 서버"]);
  });

  /**
   * hmux가 없는 서버는 SSH가 완전히 정상인 채로 셸 오류를 돌려준다. 그것을
   * "연결하지 못했습니다"로 부르면 사용자는 네트워크를 들여다본다.
   */
  it("hmux가 없는 서버를 연결 실패가 아니라 미설치로 부른다", () => {
    const failure = describeFailure(
      report("a", "가 서버", {
        state: "not_provisioned",
        detail: "bash: hmux: command not found",
      }),
    );

    expect(failure?.message).toBe("hmux가 설치되어 있지 않습니다");
    expect(failure?.detail).toContain("command not found");
  });

  it("시간이 모자라 물어보지 못한 서버와 응답이 없던 서버를 다르게 부른다", () => {
    const unreached = describeFailure(report("a", "가", { state: "not_attempted" }));
    const silent = describeFailure(report("b", "나", { state: "timed_out", seconds: 12 }));

    expect(unreached?.message).not.toBe(silent?.message);
  });

  it("성공한 서버는 실패 목록에 나타나지 않는다", () => {
    expect(describeFailure(report("a", "가", { state: "listed", sessions: [] }))).toBeUndefined();
  });
});

describe("emptyMessage", () => {
  /**
   * "세션이 없습니다"와 "아무도 대답하지 않았습니다"는 정반대의 뜻이다. 전자를
   * 후자의 상황에서 보여주면 사용자는 에이전트가 전부 죽었다고 읽는다.
   */
  it("아무도 대답하지 않은 것과 세션이 없는 것을 구분한다", () => {
    const nothingAnswered = emptyMessage([
      report("a", "가", { state: "timed_out", seconds: 12 }),
    ]);
    const answeredButEmpty = emptyMessage([report("a", "가", { state: "listed", sessions: [] })]);

    expect(nothingAnswered).not.toBe(answeredButEmpty);
    expect(answeredButEmpty).toBe("실행 중인 세션이 없습니다");
  });

  it("서버가 아예 없으면 페어링부터 하라고 말한다", () => {
    expect(emptyMessage([])).toBe("등록된 서버가 없습니다");
  });
});

describe("answeredCount", () => {
  it("대답한 서버만 센다", () => {
    expect(
      answeredCount([
        report("a", "가", { state: "listed", sessions: [] }),
        report("b", "나", { state: "unreachable", code: "x", detail: "y" }),
      ]),
    ).toBe(1);
  });
});
