// 마지막으로 연 SSH 호스트 — 분할 서브메뉴의 "최근" 표시(시안 472:26043)가
// 읽는 유일한 출처다.
//
// 스토어가 아니라 여기 사는 이유: 값은 이 클라이언트의 표시 편의값 하나이고
// 세션·레이아웃과 함께 옮겨 다닐 이유가 없다. paneCloseIntent·
// desktopCloseIntent가 같은 이유로 localStorage에 산다.

const KEY = "agent-ide-recent-ssh-host-v1";

/**
 * 읽기·쓰기 모두 실패를 삼킨다.
 *
 * private 모드나 용량 초과로 localStorage가 던져도 잃는 것은 "최근" 글자
 * 하나뿐이다 — 그것 때문에 분할이 안 되면 안 된다.
 */
export function readRecentSshHostId(): string | undefined {
	try {
		const stored = window.localStorage.getItem(KEY);
		return stored ? stored : undefined;
	} catch {
		return undefined;
	}
}

export function noteSshHostUsed(hostId: string): void {
	if (!hostId) return;
	try {
		window.localStorage.setItem(KEY, hostId);
	} catch {
		// 위 주석 참조 — 표시용 값이라 실패해도 흐름을 막지 않는다.
	}
}
