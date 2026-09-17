// 창 간 pane 이동의 명시적 레이아웃 push 알림 (localStorage 브로드캐스트).
//
// 왜 필요한가: Workspace의 외부 레이아웃 반영(applyExternalLayout)은 자기
// 창이 포커스면 스스로를 writer로 보고 건너뛴다 — 백그라운드 사본의 stale
// 되쓰기 방지책. 그런데 다른 창이 이 창의 데스크탑으로 pane을 "커밋해 넘긴"
// 직후 그 창이 닫히면(예: popout 복귀) 포커스가 즉시 이쪽으로 넘어와 그
// 가드에 걸리고, 이동이 화면에 반영되지 않은 채 자동저장이 stale 레이아웃으로
// 되엎는다. 이 채널은 "정당한 크로스-창 커밋"을 구분해 포커스와 무관하게
// 반영하게 한다. storage 이벤트는 쓴 창에서는 발화하지 않으므로 자기 자신의
// push는 받지 않는다.

export interface LayoutPushNotice {
  desktopIds: string[];
  at: number;
}

export async function projectPushedLayout(
  rehydrate: () => Promise<void>,
  project: () => boolean,
  recover: (projection: () => Promise<void>) => Promise<unknown>,
): Promise<void> {
  await recover(async () => {
    await rehydrate();
    if (!project()) {
      throw new Error("durable layout push projection was refused");
    }
  });
}

const KEY = "agent-ide-layout-push";
const LOCAL_EVENT = "dure-layout-push";

export function publishLayoutPush(
  desktopIds: readonly string[],
  options: { localDelivery?: boolean } = {},
) {
  if (desktopIds.length === 0) return;
  const notice = { desktopIds: [...desktopIds], at: Date.now() };
  try {
    localStorage.setItem(
      KEY,
      // 같은 데스크탑 연속 push도 값이 바뀌어야 storage 이벤트가 난다 — 시각+난수.
      JSON.stringify({ ...notice, nonce: Math.random() }),
    );
  } catch {
    // storage 불가 환경(테스트 등) — follow 경로(rehydrate 이벤트)가 남아 있다
  }
  if (options.localDelivery) {
    window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: notice }));
  }
}

export function parseLayoutPush(raw: string | null): LayoutPushNotice | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LayoutPushNotice>;
    if (
      Array.isArray(value.desktopIds) &&
      value.desktopIds.every((id) => typeof id === "string") &&
      typeof value.at === "number"
    ) {
      return { desktopIds: value.desktopIds, at: value.at };
    }
  } catch {
    // 손상 값 무시
  }
  return null;
}

/** 다른 창의 push 수신. 해제 함수를 돌려준다. */
export function onLayoutPush(callback: (notice: LayoutPushNotice) => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    const notice = parseLayoutPush(event.newValue);
    if (notice) callback(notice);
  };
  const localListener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    let encoded: string | null = null;
    try {
      encoded = JSON.stringify(detail);
    } catch {
      return;
    }
    const notice = parseLayoutPush(encoded);
    if (notice) callback(notice);
  };
  window.addEventListener("storage", listener);
  window.addEventListener(LOCAL_EVENT, localListener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(LOCAL_EVENT, localListener);
  };
}
