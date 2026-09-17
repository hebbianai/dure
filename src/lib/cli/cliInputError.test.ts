import { describe, expect, it } from "vitest";
import { cliInputErrorPayload } from "@/lib/cli/cliInputError";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { ManagedAgentInputError } from "@/lib/sessions/managed/managedAgentInputError";

describe("cliInputErrorPayload", () => {
	it("타입 있는 오류는 자기 코드를 유지한다", () => {
		expect(
			cliInputErrorPayload(
				new ManagedAgentInputError("input_receipt_timeout", "timed out"),
			),
		).toEqual({ code: "input_receipt_timeout", message: "timed out" });
		expect(
			cliInputErrorPayload(new PaneCommandError("pane_not_found", "no pane"))
				.code,
		).toBe("pane_not_found");
	});

	it("모르는 오류는 일반 코드로 떨어지되 메시지는 보존한다", () => {
		expect(cliInputErrorPayload(new Error("boom"))).toEqual({
			code: "hmux_input_failed",
			message: "boom",
		});
		expect(cliInputErrorPayload("just a string").message).toBe("just a string");
	});

	// 본문이 이미 타이핑된 뒤 제출만 실패한 경우. 이 신호가 없으면 CLI 사용자가
	// 그냥 다시 보내 같은 텍스트를 두 번 넣는다.
	it("본문 전달 실패는 bodyDelivered로 구분된다", () => {
		const error = new ManagedAgentInputError(
			"input_submit_failed_after_body",
			"submit failed",
		);
		error.bodyDelivered = true;
		expect(cliInputErrorPayload(error)).toEqual({
			code: "input_submit_failed_after_body",
			message: "submit failed",
			bodyDelivered: true,
		});
	});

	it("전달되지 않은 실패에는 그 키가 아예 없다 — false와 구분된다", () => {
		const payload = cliInputErrorPayload(
			new ManagedAgentInputError("input_receipt_timeout", "timed out"),
		);
		expect("bodyDelivered" in payload).toBe(false);
	});
});
