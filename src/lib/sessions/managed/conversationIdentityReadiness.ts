/** Diagnostic projection for a missing managed conversation identity.
 * Readiness explains why the Host has not projected an identity yet; it never
 * overrides an exact identity already carried by the managed binding. */

import { t } from "@/lib/i18n";

/** 아직 확정되지 않았을 뿐인 상태 — 시간이 지나면 해소된다. */
const PENDING_CODES = new Set(["conversation_identity_required"]);

export type ConversationIdentityReadiness =
	| { state: "ready"; conversationId: string }
	/** The provider has not established its first conversation yet. */
	| { state: "pending"; code: string; detail: string }
	/** Inspection cannot currently establish an identity. */
	| { state: "unavailable"; code: string; detail: string };

/** backend 오류 문자열에서 타입 코드를 뽑는다. `code: detail` 규약을 지키지
 *  않는 값은 코드 없음으로 두고 원문을 detail로 남긴다 — 삼키지 않는다. */
export function identityErrorCode(error: unknown): {
	code: string;
	detail: string;
} {
	const record =
		typeof error === "object" && error !== null
			? (error as { code?: unknown; message?: unknown })
			: undefined;
	const text =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: typeof record?.message === "string"
					? record.message
					: String(error ?? "");
	const structuredCode =
		typeof record?.code === "string" &&
		/^conversation_identity_[a-z_]+$/.test(record.code)
			? record.code
			: undefined;
	if (structuredCode) {
		const prefix = `${structuredCode}:`;
		return {
			code: structuredCode,
			detail: text.startsWith(prefix)
				? text.slice(prefix.length).trimStart() || text
				: text || structuredCode,
		};
	}
	const match = text.match(/^(conversation_identity_[a-z_]+):\s*(.*)$/s);
	if (!match) return { code: "conversation_identity_unknown", detail: text };
	return { code: match[1], detail: match[2] || text };
}

/** inspector 실패를 readiness로 투영한다. */
export function readinessFromError(
	error: unknown,
): ConversationIdentityReadiness {
	const { code, detail } = identityErrorCode(error);
	return PENDING_CODES.has(code)
		? { state: "pending", code, detail }
		: { state: "unavailable", code, detail };
}

/** 신원이 확정된 경우의 투영. */
export function readinessFromEvidence(
	conversationId: string,
): ConversationIdentityReadiness {
	return { state: "ready", conversationId };
}

/** Attach a backend diagnostic only when it belongs to the same readiness code. */
function identityBlockDiagnostic(
	code: string,
	readiness: ConversationIdentityReadiness | undefined,
): string | undefined {
	if (!readiness || readiness.state === "ready" || readiness.code !== code) {
		return undefined;
	}
	const detail = readiness.detail?.trim();
	return detail && detail !== code ? detail : undefined;
}

export function credentialMigrationIdentityBlock(
	conversationId: string | undefined,
	readiness: ConversationIdentityReadiness | undefined,
): { code: string; message: string; reason?: string } | undefined {
	if (conversationId?.trim()) return undefined;
	const code =
		readiness && readiness.state !== "ready"
			? readiness.code
			: "conversation_identity_required";
	const diagnostic = identityBlockDiagnostic(code, readiness);
	return {
		code,
		// Preserve the backend's parseable `code: detail` contract.
		message: diagnostic ? `${code}: ${diagnostic}` : code,
		reason: identityBlockReason(readiness),
	};
}

/**
 * 계정 전환이 막힌 이유를 사람이 읽을 한 줄로. 막힌 상태가 아니면 undefined.
 *
 * 코드별로 다음 행동이 다르다 — pending은 기다리면 되고, ambiguous는 사용자가
 * 상황을 정리해야 한다. "실패했습니다"만 보여주면 둘을 구분할 수 없다.
 */
export function identityBlockReason(
	readiness: ConversationIdentityReadiness | undefined,
): string | undefined {
	if (!readiness || readiness.state === "ready") return undefined;
	if (readiness.state === "pending") {
		return t("sessions.identity.conversationNotStarted");
	}
	const reason = unavailableReason(readiness.code);
	// backend 진단은 번역 대상이 아니라 증거다. 문장 뒤에 그대로 덧붙인다 —
	// 코드만 두 번 찍고 "왜"를 버리면 사용자도 우리도 원인을 못 좁힌다.
	const diagnostic = identityBlockDiagnostic(readiness.code, readiness);
	return diagnostic ? `${reason} (${diagnostic})` : reason;
}

function unavailableReason(code: string): string {
	switch (code) {
		case "conversation_identity_timeout":
			return t("sessions.identity.timeout");
		case "conversation_identity_ambiguous":
			return t("sessions.identity.ambiguous");
		case "conversation_identity_source_missing":
			return t("sessions.identity.providerExited");
		case "conversation_identity_cwd_unavailable":
			return t("sessions.identity.cwdUnreadable");
		default:
			return t("sessions.identity.unknownCode", { code });
	}
}
