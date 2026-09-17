/** 원격 세션 목록의 순수 로직. Tauri/DOM 없이 테스트된다. */

/** Rust `catalog::RemoteSession` + `DiscoveredSession.ready`와 같은 모양. */
export interface RemoteSession {
  session_id: string;
  session_name: string | null;
  workspace_id: string;
  session_class: string;
  lifecycle: string;
  provider_id: string;
  /**
   * 이 세션이 무엇을 실행하도록 띄워졌는지, 이름만.
   *
   * 인자는 오지 않는다 — 명령줄에는 비밀이 들어간다. 그리고 이건 *띄워질 때*의
   * 프로그램이라, 셸로 시작해서 나중에 ssh를 친 세션은 여전히 셸로 보인다.
   * 게이트웨이가 낡았거나 Host가 기록하지 않았으면 없다.
   */
  launch_program?: string | null;
  runner_principal: string;
  runner_instance: string;
  channel_epoch: string;
  host_instance_id: string;
  terminal_epoch: string;
  capabilities: string[];
  /** Rust 쪽에서 계산해 붙인다. `lifecycle`을 프런트에서 다시 해석하지 않는다. */
  ready: boolean;
}

/** Select within a freshly read, exact server/Hub-box catalog, never by display name. */
export function currentSession(
  previous: RemoteSession,
  listed: readonly RemoteSession[],
): RemoteSession | undefined {
  return listed.find((session) => session.session_id === previous.session_id &&
    session.workspace_id === previous.workspace_id &&
    session.runner_principal === previous.runner_principal && session.ready);
}

/**
 * 목록에 보여줄 이름.
 *
 * 이름이 없으면 세션 id를 쓴다. id를 앞 8자로 자르지 않는 이유: 같은 접두사를
 * 가진 두 세션이 화면에서 구분되지 않게 되고, 그 상태로 고른 세션은 fence가
 * 달라 attach가 거부된다 — 사용자에게는 "되는데 안 되는" 것으로 보인다.
 */
export function sessionTitle(session: RemoteSession): string {
  const name = session.session_name?.trim();
  return name && name.length > 0 ? name : session.session_id;
}

/** 부제: 워크스페이스와 제공자. 좁은 화면이라 한 줄로 합친다. */
export function sessionSubtitle(session: RemoteSession): string {
  return `${session.workspace_id} · ${session.provider_id}`;
}

/**
 * 정렬: 붙을 수 있는 세션이 먼저, 그 다음 이름.
 *
 * 목록이 서버가 준 순서(워크스페이스, 세션 id)로만 오기 때문에, 종료된 세션이
 * 위에 쌓이면 살아 있는 세션을 찾으려 스크롤해야 한다.
 */
export function sortSessions(sessions: readonly RemoteSession[]): RemoteSession[] {
  return [...sessions].sort((left, right) => {
    if (left.ready !== right.ready) return left.ready ? -1 : 1;
    const byTitle = sessionTitle(left).localeCompare(sessionTitle(right), "ko");
    if (byTitle !== 0) return byTitle;
    return left.session_id.localeCompare(right.session_id, "ko");
  });
}
