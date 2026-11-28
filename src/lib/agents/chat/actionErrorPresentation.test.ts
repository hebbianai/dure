import { describe, expect, it } from "vitest";
import {
	presentActionError,
	presentBackendRefusal,
} from "@/lib/agents/chat/actionErrorPresentation";
import { t } from "@/lib/i18n";

describe("presentActionError", () => {
	it("humanizes catalogued backend tokens and keeps the raw detail", () => {
		expect(presentActionError("agent_conversation_provider_failed")).toEqual({
			message: t("agents.chat.error.providerFailed"),
			detail: "agent_conversation_provider_failed",
		});
		expect(presentActionError("backend_request_deadline_exceeded")).toEqual({
			message: t("agents.chat.error.deadline"),
			detail: "backend_request_deadline_exceeded",
		});
	});

	it("renders unrecognized tokens verbatim with no detail", () => {
		expect(presentActionError("something_novel_went_wrong")).toEqual({
			message: "something_novel_went_wrong",
		});
	});
});

describe("presentBackendRefusal", () => {
	it("keeps a refusal's own words verbatim with its code as the detail", () => {
		expect(
			presentBackendRefusal({
				code: "agent_conversation_provider_failed",
				message: "launch_failed: Claude needs to sign in again",
			}),
		).toEqual({
			message: "launch_failed: Claude needs to sign in again",
			detail: "agent_conversation_provider_failed",
		});
	});

	it("humanizes a refusal that carries only its code", () => {
		expect(
			presentBackendRefusal({
				code: "agent_conversation_conflict",
				message: "agent_conversation_conflict",
			}),
		).toEqual(presentActionError("agent_conversation_conflict"));
	});
});
