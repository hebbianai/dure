import { t } from "@/lib/i18n";

/** Immediate errors may have an Error prefix; deferred errors carry the code. */
export function credentialSwitchFailureDescription(
	failure: string | undefined,
): string | undefined {
	if (!failure) return failure;
	if (/\bagent_runtime_provider_conversation_unavailable\b/.test(failure)) {
		return t("agents.account.conversationUnavailable");
	}
	if (/\bagent_runtime_source_retained\b/.test(failure)) {
		return t("agents.runtime.sourceRetained");
	}
	return failure;
}
