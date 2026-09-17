import { describe, expect, it } from "vitest";
import { preflightDisplay } from "@/lib/settings/providerPreflightStatus";
import type { ProviderPreflight, ProviderPreflightStatus } from "@/lib/ipc";

const make = (status: ProviderPreflightStatus, ready = false): ProviderPreflight =>
	({
		provider: "claude",
		command: "claude",
		ready,
		status,
		message: "m",
		shell: "/bin/zsh",
		cwd: "/",
		environmentSource: "login_shell",
		symlinkChain: [],
		executable: ready,
		versionTimeoutMs: 3000,
		recoveryRequiresUserApproval: true,
		suggestedRecovery: [],
	}) as ProviderPreflight;

describe("preflightDisplay", () => {
	it("응답 전과 IPC 실패를 구분해서 단언하지 않는다", () => {
		expect(preflightDisplay(undefined).key).toBe("checking");
		expect(preflightDisplay(null).key).toBe("unknown");
	});

	it("준비된 CLI는 설치됨이다", () => {
		expect(preflightDisplay(make("ready", true))).toMatchObject({ key: "installed", tone: "ok" });
	});

	// 실측 회귀: 설치된 claude가 로그인 셸 환경 타임아웃 때문에 "설치 안 됨"으로
	// 떴다. 확인 실패는 부재가 아니다 — 사용자를 재설치하러 보내면 안 된다.
	it("환경을 못 읽은 것을 설치 안 됨이라고 말하지 않는다", () => {
		for (const status of ["environment_timeout", "environment_failed"] as const) {
			const display = preflightDisplay(make(status));
			expect(display.key, status).toBe("unknown");
			expect(display.showMessage, status).toBe(true);
		}
	});

	it("정말 못 찾은 경우에만 설치 안 됨이라고 말한다", () => {
		expect(preflightDisplay(make("not_found")).key).toBe("missing");
		expect(preflightDisplay(make("path_missing")).key).toBe("missing");
	});

	// 재설치가 아니라 심링크·권한을 고쳐야 하는 상태다.
	it("찾았지만 쓸 수 없는 상태는 따로 말한다", () => {
		expect(preflightDisplay(make("broken_symlink")).key).toBe("unusable");
		expect(preflightDisplay(make("not_executable")).key).toBe("unusable");
	});

	// 새 status가 늘어도 부재로 잘못 떨어지지 않아야 한다.
	it("모르는 status는 부재가 아니라 모름으로 떨어진다", () => {
		expect(preflightDisplay(make("version_timeout")).key).toBe("unknown");
	});
});
