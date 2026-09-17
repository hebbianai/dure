import { describe, expect, it } from "vitest";
import { type RemoteSession, currentSession, sessionSubtitle, sessionTitle, sortSessions } from "./sessions";

function session(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: "sess-1",
    session_name: "작업",
    workspace_id: "ws-1",
    session_class: "standalone",
    lifecycle: "ready",
    provider_id: "claude",
    runner_principal: "kattpish",
    runner_instance: "run-7",
    channel_epoch: "3",
    host_instance_id: "host-3",
    terminal_epoch: "term-2",
    capabilities: [],
    ready: true,
    ...overrides,
  };
}

describe("sessionTitle", () => {
  it("이름이 있으면 이름을 쓴다", () => {
    expect(sessionTitle(session({ session_name: "리팩터링" }))).toBe("리팩터링");
  });

  // 앞 8자로 자르면 접두사가 같은 두 세션이 화면에서 구분되지 않고, 잘못 고른
  // 세션은 fence가 달라 attach 단계에서 거부된다.
  it("이름이 없으면 세션 id를 자르지 않고 그대로 쓴다", () => {
    const long = "0123456789abcdef0123456789abcdef";

    expect(sessionTitle(session({ session_name: null, session_id: long }))).toBe(long);
  });

  it("공백뿐인 이름은 없는 것으로 본다", () => {
    expect(sessionTitle(session({ session_name: "   ", session_id: "sess-9" }))).toBe("sess-9");
  });
});

describe("sessionSubtitle", () => {
  it("워크스페이스와 제공자를 한 줄로 합친다", () => {
    expect(sessionSubtitle(session())).toBe("ws-1 · claude");
  });
});

describe("sortSessions", () => {
  it("붙을 수 있는 세션을 위로 올린다", () => {
    const sorted = sortSessions([
      session({ session_id: "a", session_name: "가", ready: false }),
      session({ session_id: "b", session_name: "나", ready: true }),
    ]);

    expect(sorted.map((entry) => entry.session_id)).toEqual(["b", "a"]);
  });

  it("입력 배열을 바꾸지 않는다", () => {
    const sessions = [
      session({ session_id: "a", ready: false }),
      session({ session_id: "b", ready: true }),
    ];

    sortSessions(sessions);

    expect(sessions.map((entry) => entry.session_id)).toEqual(["a", "b"]);
  });

  it("이름이 같으면 세션 id로 갈린다", () => {
    const sorted = sortSessions([
      session({ session_id: "b", session_name: "같음" }),
      session({ session_id: "a", session_name: "같음" }),
    ]);

    expect(sorted.map((entry) => entry.session_id)).toEqual(["a", "b"]);
  });
});

describe("currentSession", () => {
  it("takes the complete current descriptor without comparing old generation or display fields", () => {
    const previous = session();
    const current = session({ session_name: "Renamed", provider_id: "shell",
      runner_instance: "runner-2", channel_epoch: "4", host_instance_id: "host-4", terminal_epoch: "term-3" });
    expect(currentSession(previous, [current])).toBe(current);
    expect(previous.terminal_epoch).toBe("term-2");
  });

  it.each([
    { session_id: "same-name-other-runtime" },
    { workspace_id: "other-workspace" },
    { runner_principal: "other-account" },
    { ready: false },
  ])("does not replace an absent exact target with %j", (other) => {
    expect(currentSession(session(), [session(other)])).toBeUndefined();
  });
});
