import { describe, expect, it } from "vitest";
import type { AgentChatProviderResume } from "@/lib/agents/chat/agentChatSessionView";
import { presentProviderExit } from "@/lib/agents/chat/providerExitPresentation";
import { t } from "@/lib/i18n";

const EXIT = { itemId: "lifecycle-2", reason: "exit 143" };
const ENDED = { message: t("agents.chat.providerExited"), detail: "exit 143" };
const resume = t("agents.chat.resumeSession");
const resuming = t("agents.chat.resumingSession");

describe("presentProviderExit", () => {
	it.each<
		[
			string,
			AgentChatProviderResume | undefined,
			string,
			boolean,
			ReturnType<typeof presentProviderExit>["outcome"],
		]
	>([
		["no Resume yet", undefined, resume, false, undefined],
		[
			"a Resume running",
			{ exitItemId: "lifecycle-2", state: "resuming" },
			resuming,
			true,
			undefined,
		],
		[
			"a relaunch the conversation does not show yet",
			{
				exitItemId: "lifecycle-2",
				state: "relaunched",
				runtime: { runtimeGeneration: "runtime-2", providerEpoch: "query-2" },
			},
			resuming,
			true,
			undefined,
		],
		[
			"a Resume that did not restart it",
			{ exitItemId: "lifecycle-2", state: "not_restarted" },
			resume,
			false,
			{ message: t("agents.chat.resumeNotRestarted") },
		],
		[
			"a Resume the backend refused in its own words",
			{
				exitItemId: "lifecycle-2",
				state: "failed",
				refusal: {
					code: "agent_conversation_provider_failed",
					message: "launch_failed: Claude needs to sign in again",
				},
			},
			resume,
			false,
			{
				message: t("agents.chat.resumeFailed", {
					reason: "launch_failed: Claude needs to sign in again",
				}),
				detail: "agent_conversation_provider_failed",
			},
		],
		[
			"a Resume refused with a bare code",
			{
				exitItemId: "lifecycle-2",
				state: "failed",
				refusal: {
					code: "agent_conversation_conflict",
					message: "agent_conversation_conflict",
				},
			},
			resume,
			false,
			{
				message: t("agents.chat.resumeFailed", {
					reason: t("agents.chat.error.conflict"),
				}),
				detail: "agent_conversation_conflict",
			},
		],
		[
			"a Resume of an earlier exit",
			{ exitItemId: "lifecycle-0", state: "not_restarted" },
			resume,
			false,
			undefined,
		],
	])("presents %s", (_name, state, action, pending, outcome) => {
		expect(presentProviderExit(EXIT, state)).toEqual({
			ended: ENDED,
			action,
			pending,
			...(outcome && { outcome }),
		});
	});

	it("names no detail for a clean exit", () => {
		expect(
			presentProviderExit({ itemId: "lifecycle-2", reason: null }, undefined)
				.ended,
		).toEqual({ message: t("agents.chat.providerExited") });
	});
});
