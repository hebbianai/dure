/**
 * What a phone may know about one session's provider account (#287).
 *
 * # Why these read the selector's own sources
 *
 * The phone's account sheet is the desktop account selector seen from away:
 * the same pool (`accounts` for the session's provider), the same current
 * account (`agentCredentialReferenceId`), the same queued switch, and the
 * same usage meter (`providerAccountMeter`). Deriving any of them again here
 * would let the two screens disagree about which account a session is on.
 *
 * # What never crosses
 *
 * Profile directories, credential files and tokens. Only ids needed to
 * select, the names the selector shows, and usage numbers.
 */

import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import {
	supportsAccounts,
	supportsStructuredChat,
} from "@/lib/agents/providers";
import type { SessionAccountChoiceReply } from "@/lib/hub/sessionAccountWire";
import type { SessionAccountSummary } from "@/lib/hub/sessionPresentation";
import type { UsageRecentReport } from "@/lib/ipc";
import { providerAccountMeter } from "@/lib/usage/accountUsageMeter";
import type { AccountProfile, Agent } from "@/types";

type AccountAgent = Pick<
	Agent,
	| "provider"
	| "runtimeBinding"
	| "executionProfile"
	| "credentialId"
	| "accountId"
	| "pendingCredentialSwitch"
>;

/**
 * Whether the selector's transition can run for this agent at all.
 *
 * The same two routes `requestAgentCredentialTransition` takes — a structured
 * runtime, or a managed Hmux session — so the phone is never offered a switch
 * that transition would refuse outright.
 */
export function sessionAccountSwitchable(agent: AccountAgent): boolean {
	if (!supportsAccounts(agent.provider)) return false;
	return (
		supportsStructuredChat(agent.provider) ||
		agent.runtimeBinding?.runtime === "hmux_managed_v1"
	);
}

/** Usage is observed on this computer only; an SSH session's account limits
 * are the other host's, and the selector shows none for it either. */
export function sessionAccountUsageObservable(agent: AccountAgent): boolean {
	return agent.runtimeBinding?.source !== "ssh";
}

/** The queued switch the selector draws, if any. A launch-settings change that
 * keeps the current account is not an account switch. */
function pendingAccountSwitch(agent: AccountAgent) {
	const pending = agent.pendingCredentialSwitch;
	if (agent.runtimeBinding?.runtime !== "hmux_managed_v1" || !pending) {
		return undefined;
	}
	return !pending.targetLaunchSelection ||
		pending.targetCredentialId !== pending.sourceCredentialId
		? pending
		: undefined;
}

function poolFor(agent: AccountAgent, accounts: readonly AccountProfile[]) {
	return accounts.filter((account) => account.provider === agent.provider);
}

/** The selector's current account: a reference outside the pool reads as the
 * default, exactly as the toolbar draws it. */
function currentAccount(agent: AccountAgent, pool: readonly AccountProfile[]) {
	const id = agentCredentialReferenceId(agent);
	return id ? pool.find((account) => account.id === id) : undefined;
}

/** The account line a catalog entry carries, or nothing when the phone may not switch it. */
export function sessionAccountSummary(
	agent: AccountAgent,
	accounts: readonly AccountProfile[],
): SessionAccountSummary | undefined {
	if (!sessionAccountSwitchable(agent)) return undefined;
	const pool = poolFor(agent, accounts);
	const current = currentAccount(agent, pool);
	const pending = pendingAccountSwitch(agent);
	const pendingTarget = pending?.targetCredentialId ?? null;
	return {
		...(current ? { label: current.name } : {}),
		...(pending
			? {
					pending:
						pendingTarget === null
							? {}
							: {
									label:
										pool.find((account) => account.id === pendingTarget)
											?.name ?? pendingTarget,
								},
				}
			: {}),
	};
}

/**
 * The selector's choices for this agent, with the selector's usage reading.
 *
 * `report` is the shared usage snapshot, or null when it is not read — for a
 * session on another host, whose usage this computer does not observe, the
 * same way the desktop selector shows no usage there.
 */
export function sessionAccountChoices(
	agent: AccountAgent,
	accounts: readonly AccountProfile[],
	report: UsageRecentReport | null,
	nowSec: number,
): SessionAccountChoiceReply[] {
	const pool = poolFor(agent, accounts);
	const currentId = currentAccount(agent, pool)?.id ?? null;
	const pendingId = pendingAccountSwitch(agent)?.targetCredentialId;
	const choices: { id: string | null; name?: string; dir?: string }[] = [
		{ id: null },
		...pool.map((account) => ({
			id: account.id,
			name: account.name,
			dir: account.dir,
		})),
	];
	return choices.map((choice) => {
		const meter = report
			? providerAccountMeter(
					agent.provider,
					report,
					choice.id ?? undefined,
					choice.dir,
					nowSec,
				)
			: null;
		return {
			accountId: choice.id,
			...(choice.name !== undefined ? { label: choice.name } : {}),
			current: choice.id === currentId,
			pending: pendingId !== undefined && choice.id === pendingId,
			...(meter?.pct != null && meter.window
				? {
						usage: {
							usedPercent: meter.pct,
							window: meter.window === "5h" ? "five_hour" : "weekly",
							...(meter.resetLabel ? { resetsIn: meter.resetLabel } : {}),
						},
					}
				: {}),
		};
	});
}
