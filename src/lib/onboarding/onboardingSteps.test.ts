import { describe, expect, it } from "vitest";
import {
	type OnboardingStepId,
	type OnboardingStepState,
	onboardingComplete,
	onboardingSteps,
	shouldAutoOpenOnboarding,
} from "@/lib/onboarding/onboardingSteps";

function states(
	over: Partial<Parameters<typeof onboardingSteps>[0]> = {},
): Record<OnboardingStepId, OnboardingStepState> {
	const steps = onboardingSteps({
		projectCount: 0,
		installedProviders: [],
		detectionPending: false,
		paneCount: 0,
		...over,
	});
	return Object.fromEntries(steps.map((s) => [s.id, s.state])) as Record<
		OnboardingStepId,
		OnboardingStepState
	>;
}

describe("onboardingSteps", () => {
	it("아무것도 없으면 폴더·CLI·첫 pane이 할 일이다", () => {
		expect(states()).toEqual({
			folder: "todo",
			cli: "todo",
			login: "unknown",
			firstPane: "todo",
		});
	});

	// 실수 #3(감지 강결합)의 방어선: 프로브가 아직 안 끝났으면 "없다"가 아니라
	// "확인 못 함"이다. 빈 배열은 미설치의 증명이 아니다.
	it("감지 진행 중이면 CLI는 todo가 아니라 unknown이다", () => {
		expect(states({ detectionPending: true }).cli).toBe("unknown");
	});

	it("감지된 provider가 있으면 CLI는 done이다", () => {
		expect(states({ installedProviders: ["claude"] }).cli).toBe("done");
	});

	// CLI가 없는데 로그인을 "안 됨"으로 표시하면 사용자를 두 번 불안하게 한다.
	it("CLI가 확인되기 전에는 로그인을 판정하지 않는다", () => {
		expect(states({ loggedIn: false }).login).toBe("unknown");
		expect(states({ detectionPending: true, loggedIn: false }).login).toBe(
			"unknown",
		);
	});

	it("CLI가 있고 인증 프로브가 실패하면 로그인은 unknown이다", () => {
		expect(states({ installedProviders: ["claude"] }).login).toBe("unknown");
	});

	it("CLI가 있고 미인증이 확인되면 로그인은 todo다", () => {
		expect(
			states({ installedProviders: ["claude"], loggedIn: false }).login,
		).toBe("todo");
	});

	it("폴더·pane은 라이브 개수로 판정한다", () => {
		const s = states({ projectCount: 2, paneCount: 1 });
		expect(s.folder).toBe("done");
		expect(s.firstPane).toBe("done");
	});

	// 실수 #1(계정 벽) 방어: 어떤 단계도 앱 사용을 막지 않는다.
	it("모든 단계는 건너뛸 수 있다", () => {
		for (const step of onboardingSteps({
			projectCount: 0,
			installedProviders: [],
			detectionPending: false,
			paneCount: 0,
		})) {
			expect(step.optional).toBe(true);
		}
	});
});

describe("shouldAutoOpenOnboarding", () => {
	it("작업할 폴더가 없으면 자동으로 띄운다", () => {
		expect(
			shouldAutoOpenOnboarding({ projectCount: 0, dismissed: false }),
		).toBe(true);
	});

	it("폴더가 있으면 띄우지 않는다 — 온보딩을 지난 사용자다", () => {
		expect(
			shouldAutoOpenOnboarding({ projectCount: 1, dismissed: false }),
		).toBe(false);
	});

	// 새 데스크탑은 초기 터미널을 자동으로 연다. 그 pane을 "이미 쓰고 있다"로
	// 읽으면 가이드가 첫 실행에 영원히 안 뜬다 — pane 수는 조건이 아니다.
	it("자동으로 열린 초기 터미널이 자동 표시를 막지 않는다", () => {
		expect(
			shouldAutoOpenOnboarding({ projectCount: 0, dismissed: false }),
		).toBe(true);
	});

	// 닫은 것은 사용자의 결정이다 — 빈 상태로 돌아가도 다시 밀어넣지 않는다.
	it("한 번 닫으면 자동으로 다시 뜨지 않는다", () => {
		expect(shouldAutoOpenOnboarding({ projectCount: 0, dismissed: true })).toBe(
			false,
		);
	});
});

describe("onboardingComplete", () => {
	it("확인 못 한 단계(unknown)를 완료로 세지 않는다", () => {
		expect(
			onboardingComplete(
				onboardingSteps({
					projectCount: 1,
					installedProviders: ["claude"],
					detectionPending: false,
					paneCount: 1,
				}),
			),
		).toBe(false);
	});

	it("전부 done이면 완료다", () => {
		expect(
			onboardingComplete(
				onboardingSteps({
					projectCount: 1,
					installedProviders: ["claude"],
					detectionPending: false,
					loggedIn: true,
					paneCount: 1,
				}),
			),
		).toBe(true);
	});

	it("감지된 CLI에 계정 프로필이 있으면 로그인은 done — 라이브 프로브 없이", () => {
		const steps = onboardingSteps({
			projectCount: 1,
			installedProviders: ["claude"],
			detectionPending: false,
			accountProviders: ["claude"],
			paneCount: 1,
		});
		expect(steps.find((step) => step.id === "login")?.state).toBe("done");
	});

	it("계정 프로필이 미감지 provider의 것뿐이면 증거가 아니다", () => {
		// codex 프로필만 있는데 claude만 감지된 상태 — 그 CLI의 로그인은 모른다.
		const steps = onboardingSteps({
			projectCount: 1,
			installedProviders: ["claude"],
			detectionPending: false,
			accountProviders: ["codex"],
			paneCount: 1,
		});
		expect(steps.find((step) => step.id === "login")?.state).toBe("unknown");
	});

	it("명시적 loggedIn=false는 계정 증거가 없으면 todo다", () => {
		const steps = onboardingSteps({
			projectCount: 1,
			installedProviders: ["claude"],
			detectionPending: false,
			loggedIn: false,
			paneCount: 1,
		});
		expect(steps.find((step) => step.id === "login")?.state).toBe("todo");
	});
});
