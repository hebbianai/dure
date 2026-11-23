import { describe, expect, it } from "vitest";
import {
	parseStructuredAgentPaneCommand,
	parseStructuredAgentPaneCommandOutcome,
	parseStructuredAgentPanePresentation,
	STRUCTURED_AGENT_PANE_UNAVAILABLE,
	type StructuredAgentPanePresentationV1,
} from "@/lib/agents/chat/structuredAgentPaneSurface";

const presentation: StructuredAgentPanePresentationV1 = {
	schemaVersion: 1,
	inputLocked: false,
	accountMovesLocked: false,
	accountBusy: false,
	accountFailure: "Usage limit reached",
	recoveryAccountId: "account-2",
	runtimeSwitchLocked: false,
	runtimeSwitchBusy: false,
	newConversation: true,
	conversationFailure: null,
	recovery: {
		switchAccountTarget: "Work",
		signIn: true,
		handedOff: { fromName: "Personal", toName: "Work", resend: true },
	},
};

describe("structured Agent pane presentation", () => {
	it("survives the trip to a large window unchanged", () => {
		const transferred = JSON.parse(JSON.stringify(presentation));
		expect(parseStructuredAgentPanePresentation(transferred)).toEqual(
			presentation,
		);
		expect(
			parseStructuredAgentPanePresentation(STRUCTURED_AGENT_PANE_UNAVAILABLE),
		).toEqual(STRUCTURED_AGENT_PANE_UNAVAILABLE);
	});

	it("refuses a presentation it cannot trust", () => {
		for (const candidate of [
			null,
			{ ...presentation, schemaVersion: 2 },
			{ ...presentation, inputLocked: "no" },
			{ ...presentation, accountFailure: "x".repeat(4_097) },
			{ ...presentation, recoveryAccountId: "" },
			{ ...presentation, recovery: { ...presentation.recovery, signIn: 1 } },
			{
				...presentation,
				recovery: {
					...presentation.recovery,
					handedOff: { toName: "Work", resend: true, run: "x" },
				},
			},
		]) {
			expect(parseStructuredAgentPanePresentation(candidate)).toBeUndefined();
		}
	});
});

describe("structured Agent pane commands", () => {
	it("accepts exactly the commands the pane runs", () => {
		for (const command of [
			{ kind: "switch_account", accountId: null },
			{ kind: "switch_account", accountId: "account-2" },
			{ kind: "remote_login", accountId: "account-2" },
			{ kind: "copy_to_host", accountId: "account-2" },
			{ kind: "switch_to_terminal", sourceStopPolicy: "preserve" },
			{
				kind: "switch_to_terminal",
				sourceStopPolicy: "discard",
				expectedSourceRevision: 7,
			},
			{ kind: "new_conversation" },
			{ kind: "dismiss_conversation_failure" },
			{ kind: "recovery_switch_account" },
			{ kind: "resend_last_message" },
			{ kind: "sign_in" },
		]) {
			expect(parseStructuredAgentPaneCommand(command)).toEqual(command);
		}
	});

	it("drops anything else, including extra fields", () => {
		for (const command of [
			undefined,
			{ kind: "delete_agent" },
			{ kind: "new_conversation", target: "fresh" },
			{ kind: "switch_account" },
			{ kind: "remote_login", accountId: null },
			{ kind: "switch_to_terminal", sourceStopPolicy: "force" },
			{
				kind: "switch_to_terminal",
				sourceStopPolicy: "discard",
				expectedSourceRevision: 1.5,
			},
		]) {
			expect(parseStructuredAgentPaneCommand(command)).toBeUndefined();
		}
	});

	it("accepts only a well-formed refused-switch outcome", () => {
		const outcome = {
			kind: "runtime_transition_refused",
			refusal: {
				code: "agent_runtime_source_busy",
				message: "busy",
				sourceActive: { expectedSourceRevision: 3 },
			},
		};
		expect(parseStructuredAgentPaneCommandOutcome(outcome)).toEqual(outcome);
		expect(
			parseStructuredAgentPaneCommandOutcome({ ...outcome, extra: true }),
		).toBeUndefined();
		expect(
			parseStructuredAgentPaneCommandOutcome({
				kind: "runtime_transition_refused",
				refusal: { message: "busy" },
			}),
		).toBeUndefined();
	});
});
