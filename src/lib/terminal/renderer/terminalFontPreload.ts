// 커스텀 터미널 글꼴 사전 로드.
//
// 기본 스택(ui-monospace 등)은 시스템 폰트라 즉시 사용 가능하지만, 사용자가
// 웹폰트 계열을 지정하면 첫 xterm 셀 측정이 폴백 폰트 메트릭으로 이뤄지고
// fonts.ready 재fit 때 캔버스 폭이 스냅된다(hebbian-frontend-x6r). 앱 부팅과
// 설정 변경 시 미리 로드해 첫 측정부터 올바른 메트릭을 쓰게 한다.
export function preloadTerminalFont(family: string): void {
  if (!family || typeof document === "undefined" || !document.fonts?.load) return;
  // 로드 완료를 기다리지 않는 선요청 — 실패해도 폴백 스택이 흡수한다.
  void document.fonts.load(`12px "${family}"`).catch(() => {});
}
