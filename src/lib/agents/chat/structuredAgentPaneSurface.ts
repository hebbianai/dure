/** The Chat Agent pane's own state and actions, as one surface the pane and
 * its Agent's large window both render. The pane owns every value here: its
 * session lease, account and View switches, usage-limit handoff, new
 * conversation and failures. The presentation is plain JSON so a large window
 * can mirror it, and every command runs on the pane's own handlers. */

import {
	type DureAgentRuntimeSourceStopPolicyV1,
	type DureAgentRuntimeTransitionRefusalV1,
	parseAgentRuntimeTransitionRefusal,
} from "@/lib/ipc/dureAgentRuntime";
import {
	hasOnlyKeys,
	nonNegativeInteger,
	asRecord as record,
} from "@/lib/payloadGuards";

import { t } from "@/lib/i18n";

const TEXT_LIMIT = 4_096;
const ID_LIMIT = 512;

/** The failed turn's credential recoveries the pane offers. */
interface StructuredAgentPaneRecoveryV1 {
	/** The account the handoff policy chose from fresh usage, by name. */
	readonly switchAccountTarget: string | null;
	/** A local provider sign-in in the pane's dock (not for remote panes). */
	readonly signIn: boolean;
	/** The failure was already answered by an account handoff. */
	readonly handedOff: {
		readonly fromName?: string;
		readonly toName: string;
		/** The failed message can be sent again with one click. */
		readonly resend: boolean;
	} | null;
}

export interface StructuredAgentPanePresentationV1 {
	readonly schemaVersion: 1;
	/** The composer's lock: an account, View or project move is in flight. */
	readonly inputLocked: boolean;
	/** The account switcher's and project move's disabled predicate. */
	readonly accountMovesLocked: boolean;
	readonly accountBusy: boolean;
	readonly accountFailure: string | null;
	/** The account a failed switch targeted, for its host sign-in actions. */
	readonly recoveryAccountId: string | null;
	readonly runtimeSwitchLocked: boolean;
	/** A View switch the pane runs is in flight. */
	readonly runtimeSwitchBusy: boolean;
	/** The pane's "new conversation" is available; `/clear` runs it. */
	readonly newConversation: boolean;
	/** A conversation-history or new-conversation failure on screen. */
	readonly conversationFailure: string | null;
	/** Null when the provider has no accounts to recover with. */
	readonly recovery: StructuredAgentPaneRecoveryV1 | null;
}

export type StructuredAgentPaneCommand =
	| { readonly kind: "switch_account"; readonly accountId: string | null }
	| { readonly kind: "remote_login"; readonly accountId: string }
	| { readonly kind: "copy_to_host"; readonly accountId: string }
	| {
			readonly kind: "switch_to_terminal";
			readonly sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1;
			readonly expectedSourceRevision?: number;
	  }
	| { readonly kind: "new_conversation" }
	| { readonly kind: "dismiss_conversation_failure" }
	| { readonly kind: "recovery_switch_account" }
	| { readonly kind: "resend_last_message" }
	| { readonly kind: "sign_in" };

/** What a command reports back instead of throwing: a refused View switch
 * keeps its backend refusal, so the requesting surface can offer to replace
 * an active source exactly as the pane's own control does. */
export type StructuredAgentPaneCommandOutcome = {
	readonly kind: "runtime_transition_refused";
	readonly refusal: DureAgentRuntimeTransitionRefusalV1;
};

export interface StructuredAgentPaneSurface {
	readonly presentation: StructuredAgentPanePresentationV1;
	run(
		command: StructuredAgentPaneCommand,
	): Promise<StructuredAgentPaneCommandOutcome | undefined>;
}

/** A command the pane does not offer right now (its control is disabled or
 * hidden there too). It started nothing. */
export class StructuredAgentPaneRefusal extends Error {
	readonly code = "client_chat_pane_action_unavailable";
	readonly submitted = false;
	constructor() {
		super(t("common.unavailable"));
	}
}

/** What a surface shows before the pane's presentation arrives: nothing
 * offered and every move locked. */
export const STRUCTURED_AGENT_PANE_UNAVAILABLE: StructuredAgentPanePresentationV1 =
	{
		schemaVersion: 1,
		inputLocked: true,
		accountMovesLocked: true,
		accountBusy: false,
		accountFailure: null,
		recoveryAccountId: null,
		runtimeSwitchLocked: true,
		runtimeSwitchBusy: false,
		newConversation: false,
		conversationFailure: null,
		recovery: null,
	};

function boundedText(value: unknown, limit = TEXT_LIMIT): value is string {
	return typeof value === "string" && value.length <= limit;
}

function identifier(value: unknown): value is string {
	return boundedText(value, ID_LIMIT) && value.length > 0;
}

function nullableText(value: unknown, limit = TEXT_LIMIT): boolean {
	return value === null || boundedText(value, limit);
}

function parseRecovery(
	value: unknown,
): StructuredAgentPaneRecoveryV1 | null | undefined {
	if (value === null) return null;
	const candidate = record(value);
	if (
		!candidate ||
		!hasOnlyKeys(candidate, ["switchAccountTarget", "signIn", "handedOff"]) ||
		!nullableText(candidate.switchAccountTarget, ID_LIMIT) ||
		typeof candidate.signIn !== "boolean"
	)
		return undefined;
	let handedOff: StructuredAgentPaneRecoveryV1["handedOff"] = null;
	if (candidate.handedOff !== null) {
		const handoff = record(candidate.handedOff);
		if (
			!handoff ||
			!hasOnlyKeys(handoff, ["fromName", "toName", "resend"]) ||
			(handoff.fromName !== undefined &&
				!boundedText(handoff.fromName, ID_LIMIT)) ||
			!boundedText(handoff.toName, ID_LIMIT) ||
			typeof handoff.resend !== "boolean"
		)
			return undefined;
		handedOff = {
			...(handoff.fromName !== undefined
				? { fromName: handoff.fromName as string }
				: {}),
			toName: handoff.toName,
			resend: handoff.resend,
		};
	}
	return {
		switchAccountTarget: candidate.switchAccountTarget as string | null,
		signIn: candidate.signIn,
		handedOff,
	};
}

const PRESENTATION_FLAGS = [
	"inputLocked",
	"accountMovesLocked",
	"accountBusy",
	"runtimeSwitchLocked",
	"runtimeSwitchBusy",
	"newConversation",
] as const;

export function parseStructuredAgentPanePresentation(
	value: unknown,
): StructuredAgentPanePresentationV1 | undefined {
	const candidate = record(value);
	if (
		candidate?.schemaVersion !== 1 ||
		PRESENTATION_FLAGS.some((flag) => typeof candidate[flag] !== "boolean") ||
		!nullableText(candidate.accountFailure) ||
		!(
			candidate.recoveryAccountId === null ||
			identifier(candidate.recoveryAccountId)
		) ||
		!nullableText(candidate.conversationFailure)
	)
		return undefined;
	const recovery = parseRecovery(candidate.recovery);
	if (recovery === undefined) return undefined;
	return {
		schemaVersion: 1,
		inputLocked: candidate.inputLocked as boolean,
		accountMovesLocked: candidate.accountMovesLocked as boolean,
		accountBusy: candidate.accountBusy as boolean,
		accountFailure: candidate.accountFailure as string | null,
		recoveryAccountId: candidate.recoveryAccountId as string | null,
		runtimeSwitchLocked: candidate.runtimeSwitchLocked as boolean,
		runtimeSwitchBusy: candidate.runtimeSwitchBusy as boolean,
		newConversation: candidate.newConversation as boolean,
		conversationFailure: candidate.conversationFailure as string | null,
		recovery,
	};
}

const PLAIN_COMMANDS = new Set([
	"new_conversation",
	"dismiss_conversation_failure",
	"recovery_switch_account",
	"resend_last_message",
	"sign_in",
]);

export function parseStructuredAgentPaneCommand(
	value: unknown,
): StructuredAgentPaneCommand | undefined {
	const candidate = record(value);
	if (typeof candidate?.kind !== "string") return undefined;
	const { kind } = candidate;
	if (PLAIN_COMMANDS.has(kind)) {
		return hasOnlyKeys(candidate, ["kind"])
			? ({ kind } as StructuredAgentPaneCommand)
			: undefined;
	}
	if (kind === "switch_account") {
		return hasOnlyKeys(candidate, ["kind", "accountId"]) &&
			(candidate.accountId === null || identifier(candidate.accountId))
			? { kind, accountId: candidate.accountId as string | null }
			: undefined;
	}
	if (kind === "remote_login" || kind === "copy_to_host") {
		return hasOnlyKeys(candidate, ["kind", "accountId"]) &&
			identifier(candidate.accountId)
			? { kind, accountId: candidate.accountId }
			: undefined;
	}
	if (kind === "switch_to_terminal") {
		if (
			!hasOnlyKeys(candidate, [
				"kind",
				"sourceStopPolicy",
				"expectedSourceRevision",
			]) ||
			(candidate.sourceStopPolicy !== "preserve" &&
				candidate.sourceStopPolicy !== "discard") ||
			(candidate.expectedSourceRevision !== undefined &&
				!nonNegativeInteger(candidate.expectedSourceRevision))
		)
			return undefined;
		return {
			kind,
			sourceStopPolicy: candidate.sourceStopPolicy,
			...(candidate.expectedSourceRevision !== undefined
				? { expectedSourceRevision: candidate.expectedSourceRevision as number }
				: {}),
		};
	}
	return undefined;
}

export function parseStructuredAgentPaneCommandOutcome(
	value: unknown,
): StructuredAgentPaneCommandOutcome | undefined {
	const candidate = record(value);
	if (
		candidate?.kind !== "runtime_transition_refused" ||
		!hasOnlyKeys(candidate, ["kind", "refusal"])
	)
		return undefined;
	const refusal = parseAgentRuntimeTransitionRefusal(candidate.refusal);
	return refusal ? { kind: "runtime_transition_refused", refusal } : undefined;
}
