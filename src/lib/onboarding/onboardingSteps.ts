/**
 * 첫 실행 가이드의 단계 판정 (hebbian-frontend-vfse).
 *
 * Detection or authentication failures must not block first-run access.
 * They produce unknown, and the user can continue to the next step.
 *
 * 완료 여부를 저장하지 않는 것도 의도다. 매번 라이브 상태로 판정한다. "3단계
 * 완료" 같은 자기신고 플래그를 저장하면 실제 상태와 어긋나(CLI를 지웠는데
 * 완료로 남는 식) 화면이 거짓말을 한다. 저장하는 것은 "닫았다" 한 비트뿐이다.
 */
import type { Provider } from "@/types";

export type OnboardingStepId = "folder" | "cli" | "login" | "firstPane";

/** done: 라이브로 확인됨 · unknown: 확인 못 했지만 진행 가능(fail-open) ·
 *  todo: 아직 안 함 */
export type OnboardingStepState = "done" | "unknown" | "todo";

export interface OnboardingStep {
	id: OnboardingStepId;
	state: OnboardingStepState;
	/** 이 단계를 건너뛰어도 앱을 쓸 수 있는지. false인 단계는 하나도 없어야
	 *  한다 — 계정 벽(실수 #1)을 만들지 않기 위한 명시적 표현이다. */
	optional: true;
}

export interface OnboardingInput {
	/** 등록된 작업 폴더 수 */
	projectCount: number;
	/** PATH 프로브로 감지된 provider들 */
	installedProviders: readonly Provider[];
	/** 감지 프로브가 아직 끝나지 않았는지 — 끝나기 전에는 "없다"고 단정하지
	 *  않는다(빈 배열은 "미설치"의 증명이 아니다). */
	detectionPending: boolean;
	/** 로그인 확인 결과. undefined = 확인 못 함(프로브 실패·미실행 포함) */
	loggedIn?: boolean;
	/** Saved account profiles provide local evidence without requiring a live
	 * authentication probe. A profile for a detected CLI proves prior setup. */
	accountProviders?: readonly Provider[];
	/** 현재 데스크탑에 열린 pane 수 */
	paneCount: number;
}

export function onboardingSteps(input: OnboardingInput): OnboardingStep[] {
	const cliState: OnboardingStepState =
		input.installedProviders.length > 0
			? "done"
			: input.detectionPending
				? "unknown"
				: "todo";
	// 로그인은 CLI가 확인되기 전에는 판정 자체가 무의미하다 — 없는 CLI의 인증을
	// "안 됨"으로 표시하면 사용자를 두 번 불안하게 만든다.
	const accountEvidence = (input.accountProviders ?? []).some((provider) =>
		input.installedProviders.includes(provider),
	);
	const loginState: OnboardingStepState =
		cliState !== "done"
			? "unknown"
			: input.loggedIn === true || accountEvidence
				? "done"
				: input.loggedIn === false
					? "todo"
					: "unknown";
	return [
		{
			id: "folder",
			state: input.projectCount > 0 ? "done" : "todo",
			optional: true,
		},
		{ id: "cli", state: cliState, optional: true },
		{ id: "login", state: loginState, optional: true },
		{
			id: "firstPane",
			state: input.paneCount > 0 ? "done" : "todo",
			optional: true,
		},
	];
}

/**
 * 가이드를 자동으로 띄울지 — 작업할 폴더가 하나도 없을 때만.
 *
 * pane 수를 조건에 넣지 않는다. 첫 import preview 전에는 기본 터미널을 만들지
 * 않지만, 사용자가 직접 다른 pane을 열었더라도 폴더 0개라는 첫 실행 상태는
 * 유지될 수 있다. 폴더 0개가 "아직 아무것도 못 한다"의 실제 신호다.
 *
 * 닫은 뒤에는 자동으로 다시 뜨지 않고 명시적 진입점으로만 열린다.
 */
export function shouldAutoOpenOnboarding(input: {
	projectCount: number;
	dismissed: boolean;
}): boolean {
	if (input.dismissed) return false;
	return input.projectCount === 0;
}

/** 가이드가 "다 됐다"고 볼 수 있는 상태 — 자동 표시 판단과 별개로, 완료
 *  축하문구를 띄울지에 쓴다. unknown은 완료로 세지 않는다(확인 못 한 것을
 *  됐다고 말하지 않는다). */
export function onboardingComplete(steps: readonly OnboardingStep[]): boolean {
	return steps.every((step) => step.state === "done");
}
