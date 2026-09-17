// pane 고정(pin)과 닫기 확인 — 설정 › 일반 › 탐색 › 고정된 탭을 닫기 전에 확인.
//
// 고정은 "실수로 닫지 마라"는 표시다. 세션을 바꾸거나 레이아웃을 잠그지 않고,
// 닫기 경로에 확인 한 단계만 끼운다. 판단은 전부 여기 순수 함수에 있고
// 다이얼로그·dockview 호출은 호출자 몫이다.

export type PinnedPanes = Readonly<Record<string, boolean>>;

/**
 * 고정 기록의 키.
 *
 * panel id만으로는 부족하다 — `browser:main`, `git:<projectId>`,
 * `file:<source>:<host>:<path>`처럼 결정적으로 만들어지는 id가 많아서 같은
 * id가 여러 데스크탑에 동시에 존재한다. 데스크탑을 앞에 붙여야 A에서 고정한
 * pane 때문에 B에서 닫을 때 확인 창이 뜨는 일이 없다
 * (PaneChrome의 paneRuntimeId와 같은 관례).
 */
export function panePinKey(desktopId: string | undefined, paneId: string): string {
  return `${desktopId ?? "detached"}:${paneId}`;
}

/** 이 pane이 고정 상태인가. 값이 false로 남아 있어도 고정이 아니다. */
export function isPanePinned(pinned: PinnedPanes, paneId: string): boolean {
  return pinned[paneId] === true;
}

/** 고정 토글. 해제는 키를 지운다 — false를 남겨 두면 영구 저장소에 쓸모없는
 *  항목이 계속 쌓인다. */
export function togglePinnedPane(pinned: PinnedPanes, paneId: string): Record<string, boolean> {
  const next = { ...pinned };
  if (next[paneId] === true) delete next[paneId];
  else next[paneId] = true;
  return next;
}

/** 닫기 전에 확인 다이얼로그를 띄워야 하는가. 설정이 꺼져 있으면 고정돼 있어도
 *  묻지 않는다 — 설정 문구가 약속하는 그대로다. */
export function shouldConfirmPaneClose(input: {
  pinned: PinnedPanes;
  paneId: string;
  confirmEnabled: boolean;
}): boolean {
  return input.confirmEnabled && isPanePinned(input.pinned, input.paneId);
}

/** pane 하나의 고정을 거둔다. 고정돼 있지 않았으면 원본을 그대로 돌려줘
 *  불필요한 store 갱신이 일어나지 않게 한다. */
export function unpinPane(pinned: PinnedPanes, paneId: string): PinnedPanes {
  if (pinned[paneId] === undefined) return pinned;
  const next = { ...pinned };
  delete next[paneId];
  return next;
}

/** 데스크탑 하나가 사라질 때 그 데스크탑 몫의 고정 기록을 통째로 버린다. */
export function dropPinnedPanesForDesktop(
  pinned: PinnedPanes,
  desktopId: string,
): Record<string, boolean> {
  const prefix = `${desktopId}:`;
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(pinned)) {
    if (value === true && !key.startsWith(prefix)) next[key] = true;
  }
  return next;
}
