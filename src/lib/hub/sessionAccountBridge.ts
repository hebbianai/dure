/**
 * Answering a phone that asked about, or asked to change, one session's
 * provider account (#287).
 *
 * # One transition
 *
 * A switch runs `requestAgentCredentialTransition`, the transition the
 * desktop account selector runs: the same conversation, and — when a turn is
 * running — a queued switch that happens once the turn ends, never an
 * interruption. The phone gets no second path, so whatever that transition
 * preserves (and whatever later fixes make it preserve, such as launch
 * settings), a switch from the phone preserves too.
 *
 * # Why the press has a name
 *
 * A phone whose answer never arrived cannot tell "it did not switch" from
 * "I did not hear". It retries with the same `action_id`, and this answerer
 * hands that retry the switch already running (or already finished) instead
 * of starting another restart.
 *
 * # Why it stops waiting
 *
 * A restart can outlast the hub's round-trip deadline. The answerer stops
 * watching first and says `in_progress`, so the phone tells the person the
 * switch is still running rather than inviting a second press.
 */

import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import { credentialSwitchFailureDescription } from "@/lib/agents/credentialSwitchFailureDescription";
import {
	sessionAccountChoices,
	sessionAccountSwitchable,
	sessionAccountUsageObservable,
} from "@/lib/hub/sessionAccount";
import type {
	HubSessionAccountDispatch,
	HubSessionAccountReply,
	SessionAccountChoiceReply,
} from "@/lib/hub/sessionAccountWire";
import { t } from "@/lib/i18n";
import type { UsageRecentReport } from "@/lib/ipc";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import type { AccountProfile, Agent } from "@/types";

export interface SessionAccountPorts {
	/** The agent whose hmux session the phone named, by the catalog's id. */
	readonly agentForSession: (sessionId: string) => Agent | undefined;
	/** The same agent after a transition, which may have replaced its session. */
	readonly agentById: (agentId: string) => Agent | undefined;
	readonly accounts: () => readonly AccountProfile[];
	/** The shared usage snapshot the selector reads. Usage is advisory: a
	 * rejection only leaves the readings out. */
	readonly usage: () => Promise<UsageRecentReport>;
	/** The selector's transition. */
	readonly switchAccount: (
		agentId: string,
		targetCredentialId: string | null,
	) => Promise<AgentCredentialTransitionResult>;
	readonly report: (
		requestId: string,
		reply: HubSessionAccountReply,
	) => Promise<unknown>;
	readonly now?: () => number;
	/** How long to watch a switch before answering `in_progress`. */
	readonly watchDeadlineMs?: number;
}

/**
 * Stay under the hub's 20 s round-trip deadline, so the phone hears
 * `in_progress` from this side rather than a silent timeout.
 */
const SWITCH_WATCH_DEADLINE_MS = 15_000;

/** Finished presses kept for retries after a lost answer. Bounded: a press
 * older than the last few is not one a phone is still retrying. */
const REMEMBERED_PRESSES = 32;

type Settled =
	| { readonly kind: "switched" | "scheduled" }
	| {
			readonly kind: "refused";
			readonly detail: string;
			readonly code: string;
	  };

/** One press being (or already) carried out. */
interface Press {
	readonly agentId: string;
	readonly settled: Promise<Settled>;
}

function refused(detail: string, code: string): HubSessionAccountReply {
	return { outcome: "refused", accounts: [], detail, code };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The refusal a failed transition becomes. Busy is its own code: it asks the
 * person to wait for the turn, not to try another account. */
function failure(error: unknown): Extract<Settled, { kind: "refused" }> {
	if (error instanceof DureAgentRuntimeSourceActiveError) {
		return {
			kind: "refused",
			detail: t("sessions.hubAccountSwitch.busy"),
			code: "busy",
		};
	}
	const message = errorText(error);
	if (/\bcredential_reference_unavailable\b/.test(message)) {
		return {
			kind: "refused",
			detail: t("sessions.hubAccountSwitch.accountMissing"),
			code: "account_missing",
		};
	}
	return {
		kind: "refused",
		detail: t("sessions.hubAccountSwitch.failed", {
			error: credentialSwitchFailureDescription(message) ?? message,
		}),
		code: "failed",
	};
}

export function createHubSessionAccountAnswerer(
	ports: SessionAccountPorts,
): (dispatch: HubSessionAccountDispatch) => Promise<void> {
	const presses = new Map<string, Press>();
	const now = ports.now ?? Date.now;
	const deadline = ports.watchDeadlineMs ?? SWITCH_WATCH_DEADLINE_MS;

	async function choices(
		agent: Agent | undefined,
	): Promise<SessionAccountChoiceReply[]> {
		if (!agent) return [];
		const report = sessionAccountUsageObservable(agent)
			? await ports.usage().catch(() => null)
			: null;
		return sessionAccountChoices(agent, ports.accounts(), report, now() / 1000);
	}

	function remember(actionId: string, press: Press): void {
		presses.set(actionId, press);
		while (presses.size > REMEMBERED_PRESSES) {
			const oldest = presses.keys().next().value;
			if (oldest === undefined) break;
			presses.delete(oldest);
		}
	}

	async function watch(
		settled: Promise<Settled>,
	): Promise<Settled | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stopped = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), deadline);
		});
		try {
			return await Promise.race([settled, stopped]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Answer from a press. The agent is read again by id: the switch may have
	 * replaced the session the phone named. */
	async function answer(press: Press): Promise<HubSessionAccountReply> {
		const settled = await watch(press.settled);
		const agent = ports.agentById(press.agentId);
		if (!settled) {
			return {
				outcome: "in_progress",
				accounts: await choices(agent),
				detail: t("sessions.hubAccountSwitch.stillSwitching"),
				code: "still_switching",
			};
		}
		if (settled.kind === "refused")
			return refused(settled.detail, settled.code);
		return { outcome: settled.kind, accounts: await choices(agent) };
	}

	async function decide(
		dispatch: HubSessionAccountDispatch,
	): Promise<HubSessionAccountReply> {
		const request = dispatch.switch;
		// A retry of a press already taken reaches that press, even when the
		// switch has since replaced the session the phone named.
		const earlier = request ? presses.get(request.action_id) : undefined;
		if (earlier) return answer(earlier);
		const agent = ports.agentForSession(dispatch.session_id);
		if (!agent) {
			return refused(
				t("sessions.hubAccountSwitch.sessionMissing"),
				"session_missing",
			);
		}
		if (!sessionAccountSwitchable(agent)) {
			return refused(t("sessions.hubAccountSwitch.unsupported"), "unsupported");
		}
		if (!request) return { outcome: "listed", accounts: await choices(agent) };
		const target = sessionAccountChoices(agent, ports.accounts(), null, 0).find(
			(choice) => choice.accountId === request.account_id,
		);
		if (!target) {
			return refused(
				t("sessions.hubAccountSwitch.accountMissing"),
				"account_missing",
			);
		}
		// The selector ignores a press on the account already in use; a phone
		// gets the reason instead of silence.
		if (target.current) {
			return refused(
				t("sessions.hubAccountSwitch.alreadyCurrent"),
				"already_current",
			);
		}
		const press: Press = {
			agentId: agent.id,
			settled: ports.switchAccount(agent.id, request.account_id).then(
				(result): Settled => ({
					kind: result.kind === "scheduled" ? "scheduled" : "switched",
				}),
				failure,
			),
		};
		remember(request.action_id, press);
		return answer(press);
	}

	return async (dispatch) => {
		let reply: HubSessionAccountReply;
		try {
			reply = await decide(dispatch);
		} catch (cause) {
			const settled = failure(cause);
			reply = refused(settled.detail, settled.code);
		}
		await ports.report(dispatch.request_id, reply);
	};
}
