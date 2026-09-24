import { describe, expect, it } from "vitest";
import { credentialSwitchFailureDescription } from "@/lib/agents/credentialSwitchFailureDescription";
import { t } from "@/lib/i18n";

describe("credentialSwitchFailureDescription", () => {
	it.each([
		"agent_runtime_provider_conversation_unavailable",
		"Error: agent_runtime_provider_conversation_unavailable",
	])("explains missing conversation identity for %s", (failure) => {
		expect(credentialSwitchFailureDescription(failure)).toBe(
			t("agents.account.conversationUnavailable"),
		);
	});

	it("explains a retained source in immediate errors too", () => {
		expect(
			credentialSwitchFailureDescription(
				"Error: agent_runtime_source_retained",
			),
		).toBe(t("agents.runtime.sourceRetained"));
	});

	it.each([
		undefined,
		"",
		"credential unavailable",
		"agent_runtime_provider_conversation_unavailable_other",
	])("preserves unknown failure %s", (failure) => {
		expect(credentialSwitchFailureDescription(failure)).toBe(failure);
	});
});
