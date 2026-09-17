import { describe, expect, it } from "vitest";
import {
	credentialMigrationIdentityBlock,
	identityBlockReason,
	identityErrorCode,
	readinessFromError,
	readinessFromEvidence,
} from "@/lib/sessions/managed/conversationIdentityReadiness";

describe("identityErrorCode", () => {
	it("`code: detail` 규약에서 코드를 뽑는다", () => {
		expect(
			identityErrorCode(
				"conversation_identity_ambiguous: provider has multiple resume commands",
			),
		).toEqual({
			code: "conversation_identity_ambiguous",
			detail: "provider has multiple resume commands",
		});
	});

	it("Error 객체도 같은 규약으로 읽는다", () => {
		expect(
			identityErrorCode(
				new Error("conversation_identity_required: no open rollout"),
			).code,
		).toBe("conversation_identity_required");
	});

	it("Tauri가 plain object로 전달한 message와 code도 보존한다", () => {
		expect(
			identityErrorCode({
				message: "conversation_identity_required: no open rollout",
			}),
		).toEqual({
			code: "conversation_identity_required",
			detail: "no open rollout",
		});
		expect(
			identityErrorCode({
				code: "conversation_identity_unverified",
				message: "runtime evidence is incomplete",
			}),
		).toEqual({
			code: "conversation_identity_unverified",
			detail: "runtime evidence is incomplete",
		});
	});

	it("여러 줄 detail을 잘라내지 않는다", () => {
		const { detail } = identityErrorCode(
			"conversation_identity_mismatch: a\nb",
		);
		expect(detail).toBe("a\nb");
	});

	// 삼키지 않는 것이 이 모듈의 존재 이유다.
	it("규약을 안 지킨 값도 버리지 않고 원문을 남긴다", () => {
		expect(identityErrorCode("boom")).toEqual({
			code: "conversation_identity_unknown",
			detail: "boom",
		});
		expect(identityErrorCode(undefined).code).toBe(
			"conversation_identity_unknown",
		);
	});

	it("비슷하지만 다른 접두사를 코드로 오인하지 않는다", () => {
		expect(
			identityErrorCode("credential_binding_invalid_identity: x").code,
		).toBe("conversation_identity_unknown");
	});
});

describe("readinessFromError", () => {
	// 첫 입력 전에는 rollout이 없다 — 오류가 아니라 아직이다.
	it("열린 rollout이 없는 것은 pending이다", () => {
		const readiness = readinessFromError(
			"conversation_identity_required: provider has no open Codex rollout",
		);
		expect(readiness.state).toBe("pending");
	});

	it("rollout이 여러 개면 unavailable이다 — 추측으로 고르지 않는다", () => {
		expect(
			readinessFromError("conversation_identity_ambiguous: multiple").state,
		).toBe("unavailable");
	});

	it.each([
		"conversation_identity_source_missing: managed provider exited",
		"conversation_identity_source_mismatch: managed Host generation changed",
		"conversation_identity_process_changed: pid reused",
		"conversation_identity_cwd_unavailable: cwd not readable",
		"conversation_identity_unverified: evidence incomplete",
		"conversation_identity_adapter_unsupported: no adapter",
	])("%s 는 unavailable이다", (error) => {
		expect(readinessFromError(error).state).toBe("unavailable");
	});

	it("정체불명 오류는 pending으로 낙관하지 않는다", () => {
		expect(readinessFromError("boom").state).toBe("unavailable");
	});

	it("코드와 detail을 그대로 보존한다 — UI가 이유를 보여줄 수 있어야 한다", () => {
		const readiness = readinessFromError(
			"conversation_identity_ambiguous: two rollouts",
		);
		expect(readiness).toMatchObject({
			code: "conversation_identity_ambiguous",
			detail: "two rollouts",
		});
	});
});

describe("identityBlockReason", () => {
	it("확정된 상태에는 이유가 없다", () => {
		expect(
			identityBlockReason(readinessFromEvidence("conv-1")),
		).toBeUndefined();
		expect(identityBlockReason(undefined)).toBeUndefined();
	});

	// 기다리면 되는 상태와 사용자가 정리해야 하는 상태는 다음 행동이 다르다.
	it("pending은 '첫 메시지를 보내라'로 안내한다", () => {
		expect(
			identityBlockReason(
				readinessFromError("conversation_identity_required: x"),
			),
		).toMatch(/첫 메시지/);
	});

	it("대화가 여러 개면 그 사실을 말한다", () => {
		expect(
			identityBlockReason(
				readinessFromError("conversation_identity_ambiguous: x"),
			),
		).toMatch(/여러 개/);
	});

	it("bounded 관측 timeout은 재시도 가능한 진단으로 설명한다", () => {
		expect(
			identityBlockReason(
				readinessFromError(
					"conversation_identity_timeout: exact identity was not observed",
				),
			),
		).toMatch(/다시 메시지/);
	});

	it("모르는 코드도 삼키지 않고 코드를 노출한다", () => {
		expect(
			identityBlockReason(readinessFromError("conversation_identity_weird: x")),
		).toContain("conversation_identity_weird");
	});

	// 코드만 두 번 찍고 backend 진단을 버리면 다섯 가지 실패 원인 중 어느
	// 것이었는지 사용자도 우리도 좁힐 수 없다.
	it("backend 진단을 문장 뒤에 그대로 붙인다", () => {
		expect(
			identityBlockReason(
				readinessFromError(
					"conversation_identity_unverified: Claude project directory is untrusted",
				),
			),
		).toContain("Claude project directory is untrusted");
		expect(
			identityBlockReason(
				readinessFromError(
					"conversation_identity_ambiguous: two open rollouts share no root",
				),
			),
		).toContain("two open rollouts share no root");
	});

	it("코드만 반복하는 진단은 붙이지 않는다", () => {
		expect(
			identityBlockReason({
				state: "unavailable",
				code: "conversation_identity_unverified",
				detail: "conversation_identity_unverified",
			}),
		).not.toContain("conversation_identity_unverified (");
	});
});

describe("credentialMigrationIdentityBlock message", () => {
	it("throw할 메시지에 backend 규약대로 사유를 싣는다", () => {
		const block = credentialMigrationIdentityBlock(
			undefined,
			readinessFromError(
				"conversation_identity_unverified: Claude live session cwd is unavailable",
			),
		);

		expect(block?.message).toBe(
			"conversation_identity_unverified: Claude live session cwd is unavailable",
		);
		// backend 규약을 유지했으므로 다시 파싱할 수 있어야 한다.
		expect(identityErrorCode(block?.message).code).toBe(
			"conversation_identity_unverified",
		);
	});

	it("does not reinterpret readiness after an exact identity exists", () => {
		expect(
			credentialMigrationIdentityBlock(
				"conv-1",
				readinessFromEvidence("conv-2"),
			),
		).toBeUndefined();
	});

	it("사유가 없으면 코드만 남는다", () => {
		expect(
			credentialMigrationIdentityBlock(undefined, undefined)?.message,
		).toBe("conversation_identity_required");
	});
});
