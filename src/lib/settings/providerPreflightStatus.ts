// preflight 결과를 화면 낱말로 옮긴다 — 설정 › 프로바이더의 순수 로직.
//
// 이 모듈이 생긴 이유: 예전에는 `ready` 불리언 하나만 보고 false면 전부
// "설치 안 됨"이라고 썼다. 백엔드는 이미 원인을 status로 구분해 주는데
// (`environment_timeout`은 "로그인 셸 환경을 못 읽었다"이지 "CLI가 없다"가
// 아니다) 화면이 그걸 버리고 단언한 것이다. 실제로 2026-08-11에 멀쩡히 설치된
// claude가 "Not installed"로 떴다 — 사용자를 재설치하러 보내는 거짓말이다.
//
// 원칙: 모르는 것을 아는 것처럼 쓰지 않는다. 확인 실패와 부재는 다른 낱말이다.

import type { ProviderPreflight, ProviderPreflightStatus } from "@/lib/ipc";

type PreflightTone = "ok" | "warn";

export interface PreflightDisplay {
	/** 상태 낱말 키 — 호출부가 t()로 옮긴다. */
	key:
		| "checking"
		| "installed"
		| "unknown"
		| "missing"
		| "unusable";
	tone: PreflightTone;
	/** 사람이 손댈 수 있는 설명(백엔드 message)을 그대로 보여줄지. */
	showMessage: boolean;
}

/** 확인 자체가 실패한 상태들 — CLI의 존재 여부에 대해 아무것도 말해 주지 않는다. */
const INDETERMINATE: ReadonlySet<ProviderPreflightStatus> = new Set([
	"environment_timeout",
	"environment_failed",
]);

/** 찾지 못한 상태들 — 여기서만 "설치 안 됨"이라고 말할 자격이 있다. */
const ABSENT: ReadonlySet<ProviderPreflightStatus> = new Set([
	"not_found",
	"path_missing",
]);

/** 찾았지만 쓸 수 없는 상태들. "없다"와 구분해야 사용자가 할 일이 달라진다
 *  (재설치가 아니라 심링크·권한을 고쳐야 한다). */
const UNUSABLE: ReadonlySet<ProviderPreflightStatus> = new Set([
	"broken_symlink",
	"not_executable",
]);

export function preflightDisplay(
	preflight: ProviderPreflight | null | undefined,
): PreflightDisplay {
	if (preflight === undefined) return { key: "checking", tone: "ok", showMessage: false };
	// IPC 자체가 실패한 경우도 "모름"이다 — 물어보지 못한 것과 물어봤는데
	// 환경을 못 읽은 것은 사용자 입장에서 같은 상태다.
	if (preflight === null) return { key: "unknown", tone: "warn", showMessage: false };
	if (preflight.ready) return { key: "installed", tone: "ok", showMessage: false };
	if (INDETERMINATE.has(preflight.status)) {
		return { key: "unknown", tone: "warn", showMessage: true };
	}
	if (UNUSABLE.has(preflight.status)) {
		return { key: "unusable", tone: "warn", showMessage: true };
	}
	if (ABSENT.has(preflight.status)) {
		return { key: "missing", tone: "warn", showMessage: true };
	}
	// 남은 status(version_timeout 등)는 경로까지는 풀렸다는 뜻이라 부재가 아니다.
	// 새 status가 추가돼도 "설치 안 됨"으로 잘못 떨어지지 않게 여기로 모은다.
	return { key: "unknown", tone: "warn", showMessage: true };
}
