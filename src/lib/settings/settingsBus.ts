// 설정 다이얼로그를 특정 페이지로 여는 창-전역 이벤트 버스.
// settingsOpen 상태는 Sidebar 로컬이라 다른 컴포넌트(예: DesktopBar 사용량
// 배지)에서 직접 열 수 없다 — 가벼운 CustomEvent로 요청만 보낸다.

const OPEN_SETTINGS_EVENT = "dure:open-settings";

/** 설정을 특정 페이지로 열도록 요청한다(page 미지정 시 기본 페이지). */
export function openSettingsPage(page?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { page } }));
}

/** 설정 열기 요청 구독. 반환값은 해제 함수. */
export function onOpenSettings(cb: (page: string | undefined) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<{ page?: string }>).detail?.page);
  window.addEventListener(OPEN_SETTINGS_EVENT, handler);
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler);
}
