const MAX_INTENT_AGE_MS = 10_000;

interface DesktopTransitionIntent {
  desktopId: string;
  startedAt: number;
}

let pendingIntent: DesktopTransitionIntent | undefined;

const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/** Store mutation 앞에서 사용자/programmatic desktop 이동 의도를 기록한다. */
export function markDesktopTransitionIntent(
  desktopId: string,
  startedAt = monotonicNow(),
) {
  pendingIntent = { desktopId, startedAt };
}

/**
 * WorkspaceDeck이 renderer/model/cold tier를 판정한 뒤 같은 이동의 시작 시각을
 * 한 번만 가져간다. 다른 desktop 또는 오래된 intent는 다음 전환에 섞지 않는다.
 */
export function consumeDesktopTransitionIntent(
  desktopId: string,
  consumedAt = monotonicNow(),
) {
  const intent = pendingIntent;
  pendingIntent = undefined;
  if (
    !intent ||
    intent.desktopId !== desktopId ||
    consumedAt - intent.startedAt > MAX_INTENT_AGE_MS
  ) {
    return undefined;
  }
  return intent.startedAt;
}
