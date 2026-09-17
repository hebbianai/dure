/**
 * CLI 입력 실패를 응답 payload로 옮기는 순수 매핑 (cliServer god-file 다이어트).
 *
 * 여기서 중요한 것은 `bodyDelivered`다. text와 submit은 별도 semantic intent라
 * 본문은 이미 대상 PTY에 타이핑됐는데 제출만 실패할 수 있다. 그때 CLI 사용자가
 * 그냥 다시 보내면 같은 텍스트가 두 번 들어간다 — "다시 보내야 하는가"와
 * "Enter만 누르면 되는가"를 응답으로 구분해줘야 한다 (hebbian-frontend-jazw).
 */

import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { ManagedAgentInputError } from "@/lib/sessions/managed/managedAgentInputError";

export interface CliInputErrorPayload {
	code: string;
	message: string;
	/** 본문은 전달됐고 제출만 실패했을 때만 존재한다. */
	bodyDelivered?: true;
}

export function cliInputErrorPayload(error: unknown): CliInputErrorPayload {
	const code =
		error instanceof PaneCommandError || error instanceof ManagedAgentInputError
			? error.code
			: "hmux_input_failed";
	const payload: CliInputErrorPayload = {
		code,
		message: error instanceof Error ? error.message : String(error),
	};
	if (error instanceof ManagedAgentInputError && error.bodyDelivered) {
		payload.bodyDelivered = true;
	}
	return payload;
}
