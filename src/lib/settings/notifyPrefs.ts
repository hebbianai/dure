/** 알림 설정 (설정 창 '알림' 페이지) — store에서 추출(god-file 다이어트).
 *  terminalPrefs.ts / uiPrefs.ts와 같은 규칙: 값 타입과 기본값만 두고,
 *  store는 이 모듈을 재노출해 기존 import 경로를 유지한다. */
export interface NotifyPrefs {
  /** 마스터 스위치 — 끄면 모든 데스크톱 알림 중단 */
  enabled: boolean;
  /** 에이전트가 응답을 마치고 입력을 기다릴 때 */
  agentDone: boolean;
  /** 에이전트가 명령 실행이나 권한 승인을 기다릴 때 */
  approvalRequired: boolean;
  /** 에이전트 세션 프로세스가 종료됐을 때 */
  agentExited: boolean;
  /** 백그라운드 터미널이 벨(BEL)을 울렸을 때 */
  terminalBell: boolean;
  /** 알림 사운드 선택값 (시스템 기본음/무음 sentinel 또는 macOS 사운드 이름) */
  sound: string;
  /** 해당 패널을 보고 있으면 알림 생략 (기존 동작) */
  suppressWhenVisible: boolean;
}

export const NOTIFICATION_SOUND_SYSTEM = "__system__";
export const NOTIFICATION_SOUND_NONE = "__none__";
const NATIVE_NOTIFICATION_SOUND_SYSTEM = "__dure_system_default__";

/** 구버전의 빈 값은 UI에서 "시스템 기본값"으로 보였으므로 같은 의미로 보존한다. */
export function normalizedNotificationSoundPreference(sound: unknown): string {
  return typeof sound === "string" && sound !== "" && sound !== NOTIFICATION_SOUND_SYSTEM
    ? sound
    : NOTIFICATION_SOUND_SYSTEM;
}

/** 설정값을 native adapter가 구분할 수 있는 기본음 marker 또는 이름으로 바꾼다. */
export function notificationSoundForDispatch(
  sound: string | undefined,
): string | undefined {
  const normalized = normalizedNotificationSoundPreference(sound);
  if (normalized === NOTIFICATION_SOUND_NONE) return undefined;
  if (normalized === NOTIFICATION_SOUND_SYSTEM) return NATIVE_NOTIFICATION_SOUND_SYSTEM;
  return normalized;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  enabled: true,
  agentDone: true,
  approvalRequired: true,
  agentExited: true,
  terminalBell: true,
  sound: NOTIFICATION_SOUND_SYSTEM,
  suppressWhenVisible: true,
};

/** 누적 활동 통계 (설정 '통계 및 사용량' 상단 카드). 앱이 켜진 이후부터 집계 —
 *  과거 소급 없음. */
export interface AppStats {
  /** 이 앱으로 시작한 에이전트 누적 수 */
  agentsStarted: number;
  /** 생성한 PR 누적 수 (GitPanel의 PR 만들기) */
  prsCreated: number;
  /** 에이전트가 working이던 시간 누적(ms, 에이전트별 man-time 합) */
  activeMs: number;
  /** 추적 시작 시각 (epoch ms) */
  since: number;
}
