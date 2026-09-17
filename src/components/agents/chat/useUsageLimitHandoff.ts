import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { UsageLimitResumeResult } from "@/lib/agents/chat/resumeUsageLimitTurn";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import type {
	LatestTurnFailure,
	TurnFailureReason,
} from "@/lib/agents/chat/turnFailureReason";
import {
	DEFAULT_FRESH_WITHIN_SEC,
	decideUsageLimitHandoff,
	observationAfterReportedLimit,
	type UsageLimitHandoffDecision,
} from "@/lib/agents/usageLimitHandoffPolicy";
import { usageRecent } from "@/lib/ipc";
import { accountUsageObservations } from "@/lib/usage/accountUsageObservations";
import type { AccountProfile, Provider } from "@/types";

/** Reasons an observed conversation moves on by itself; a sign-in failure only offers the
 * move, because switching accounts cannot fix credentials that are wrong. */
const AUTOMATIC_REASONS: ReadonlySet<TurnFailureReason> = new Set([
	"usage_limit",
	"rate_limit",
]);
const CREDENTIAL_REASONS: ReadonlySet<TurnFailureReason> = new Set([
	"usage_limit",
	"rate_limit",
	"authentication_failed",
]);

/** Once per failed-turn episode, across remounts, duplicate mounts, and the
 * history replay a successful handoff performs into its new session (which
 * re-emits the same failure with the same provider timestamp under a new
 * row id). Keyed by agent, valued by the newest failure already acted on. */
const handledFailureAtMs = new Map<string, number>();

interface UsageLimitHandoffOutcome {
	readonly fromName?: string;
	readonly toName: string;
	readonly resume?: UsageLimitResumeResult;
}

/** What the last performed handoff did, keyed by agent, so the pane can say
 * "moved from X to Y" after the new session replays the failed turn. */
const handoffOutcomes = new Map<string, UsageLimitHandoffOutcome>();
const listeners = new Set<() => void>();
let revision = 0;
function publishHandoff() {
	revision += 1;
	for (const listener of listeners) listener();
}
function subscribeHandoff(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
const handoffRevision = () => revision;

/** Accounts the provider itself reported at their limit, keyed
 * `<provider>:<credentialId>`, valued by when. Outranks an older poll so a
 * pane never hops back onto the account it just left. */
const reportedLimitAtSec = new Map<string, number>();

function markHandled(agentId: string, failure: LatestTurnFailure): boolean {
	const handled = handledFailureAtMs.get(agentId);
	if (handled !== undefined && handled >= failure.createdAtMs) return false;
	handledFailureAtMs.set(agentId, failure.createdAtMs);
	handoffOutcomes.delete(agentId);
	publishHandoff();
	return true;
}

function episodeHandled(agentId: string, failure: LatestTurnFailure): boolean {
	const handled = handledFailureAtMs.get(agentId);
	return handled !== undefined && handled >= failure.createdAtMs;
}

export type UsageLimitHandoffView =
	| { readonly kind: "none" }
	/** This episode was already acted on (here or in a previous mount of
	 * the pane): no recovery action is left; `outcome` says what was done. */
	| { readonly kind: "handled"; readonly outcome?: UsageLimitHandoffOutcome }
	| { readonly kind: "deciding" }
	| { readonly kind: "decided"; readonly decision: UsageLimitHandoffDecision };

/** Decides and, when opted in, performs the usage-limit handoff for one
 * observed Chat conversation. Target selection is the policy's alone; the banner's "Switch
 * to X", the `handoff` pane action, and the automatic trigger all read the
 * same decision, so they can never name different accounts. The automatic
 * move fires only for a failure that happened while this observer was mounted,
 * never for one replayed from history after a reload. */
export function useUsageLimitHandoff({
	agentId,
	provider,
	automatic,
	accountMovesLocked,
	currentCredentialId,
	pool,
	failure,
	performAccountSwitch,
	resumeAfterHandoff,
}: {
	readonly agentId: string;
	readonly provider: Provider;
	/** Settings opt-in and a local conversation permit an automatic move. */
	readonly automatic: boolean;
	/** The toolbar switcher's own disabled predicate; while true the pane
	 * neither offers nor performs an account move. */
	readonly accountMovesLocked: boolean;
	readonly currentCredentialId: string | undefined;
	readonly pool: readonly AccountProfile[];
	readonly failure: LatestTurnFailure | undefined;
	readonly performAccountSwitch: (
		credentialId: string,
	) => Promise<AgentCredentialTransitionResult>;
	readonly resumeAfterHandoff: (
		failure: LatestTurnFailure,
		result: AgentCredentialTransitionResult,
	) => Promise<UsageLimitResumeResult>;
}): {
	readonly view: UsageLimitHandoffView;
	readonly requestHandoff: () => Promise<void>;
} {
	useSyncExternalStore(subscribeHandoff, handoffRevision, handoffRevision);
	const [decision, setDecision] = useState<UsageLimitHandoffDecision>();
	const mountedAtMs = useRef(Date.now());
	const switchRef = useRef(performAccountSwitch);
	switchRef.current = performAccountSwitch;
	const resumeRef = useRef(resumeAfterHandoff);
	resumeRef.current = resumeAfterHandoff;
	const poolRef = useRef(pool);
	poolRef.current = pool;
	const failureRef = useRef(failure);
	failureRef.current = failure;
	const credentialFailure =
		failure && CREDENTIAL_REASONS.has(failure.reason) ? failure : undefined;
	const handled =
		credentialFailure !== undefined &&
		episodeHandled(agentId, credentialFailure);
	const failureItemId = handled ? undefined : credentialFailure?.itemId;
	const failureReason = credentialFailure?.reason;
	const failureCreatedAtMs = credentialFailure?.createdAtMs;
	const poolKey = pool.map((account) => account.id).join(",");

	useEffect(() => {
		// A new episode (or none) invalidates the previous decision at once,
		// so the banner never offers the account the pane is already on.
		setDecision(undefined);
		if (failureItemId === undefined || failureReason === undefined) return;
		if (
			currentCredentialId !== undefined &&
			failureCreatedAtMs !== undefined &&
			AUTOMATIC_REASONS.has(failureReason)
		) {
			reportedLimitAtSec.set(
				`${provider}:${currentCredentialId}`,
				failureCreatedAtMs / 1000,
			);
		}
		let current = true;
		void usageRecent(5)
			.catch(() => undefined)
			.then((report) => {
				if (!current) return;
				const nowSec = Date.now() / 1000;
				const currentPool = poolRef.current;
				const currentName = currentPool.find(
					(account) => account.id === currentCredentialId,
				)?.name;
				const observations = accountUsageObservations(
					provider,
					report,
					currentPool,
					nowSec,
				).map((observation) => {
					const reportedAt = reportedLimitAtSec.get(
						`${provider}:${observation.credentialId}`,
					);
					return reportedAt !== undefined &&
						nowSec - reportedAt <= DEFAULT_FRESH_WITHIN_SEC
						? observationAfterReportedLimit(observation, reportedAt)
						: observation;
				});
				const next = decideUsageLimitHandoff({
					currentCredentialId,
					pool: currentPool,
					observations,
					nowSec,
				});
				setDecision(next);
				const latest = failureRef.current;
				if (
					next.kind !== "handoff" ||
					!automatic ||
					accountMovesLocked ||
					!latest ||
					!AUTOMATIC_REASONS.has(latest.reason) ||
					latest.createdAtMs < mountedAtMs.current ||
					!markHandled(agentId, latest)
				) {
					return;
				}
				void switchRef
					.current(next.targetCredentialId)
					.then(async (result) => {
						if (result.kind !== "completed") return;
						const outcome: UsageLimitHandoffOutcome = {
							...(currentName !== undefined ? { fromName: currentName } : {}),
							toName: next.targetName,
						};
						// Keep the manual resend hidden until this one automatic
						// attempt settles. A lost receipt never starts a second turn.
						try {
							const resume = await resumeRef.current(latest, result);
							handoffOutcomes.set(agentId, { ...outcome, resume });
						} catch {
							handoffOutcomes.set(agentId, outcome);
						} finally {
							publishHandoff();
						}
					})
					.catch(() => {})
					.finally(() => setDecision(undefined));
			})
			.catch(() => {
				if (current) setDecision(undefined);
			});
		return () => {
			current = false;
		};
	}, [
		agentId,
		provider,
		automatic,
		accountMovesLocked,
		currentCredentialId,
		poolKey,
		failureItemId,
		failureReason,
		failureCreatedAtMs,
	]);

	const requestHandoff = useCallback(async () => {
		if (!decision) throw new Error("handoff_undecided");
		if (decision.kind === "refused") {
			throw new Error(
				`handoff_refused:${decision.code}: ${decision.nextAction}`,
			);
		}
		const latest = failureRef.current;
		if (latest && episodeHandled(agentId, latest)) {
			throw new Error("handoff_already_performed");
		}
		if (latest) markHandled(agentId, latest);
		const fromName = poolRef.current.find(
			(account) => account.id === currentCredentialId,
		)?.name;
		const result = await switchRef.current(decision.targetCredentialId);
		if (result.kind === "completed")
			handoffOutcomes.set(agentId, {
				...(fromName !== undefined ? { fromName } : {}),
				toName: decision.targetName,
			});
		publishHandoff();
		setDecision(undefined);
	}, [agentId, currentCredentialId, decision]);

	const outcome = handoffOutcomes.get(agentId);
	const view: UsageLimitHandoffView = !credentialFailure
		? { kind: "none" }
		: handled
			? { kind: "handled", ...(outcome ? { outcome } : {}) }
			: decision
				? { kind: "decided", decision }
				: { kind: "deciding" };
	return { view, requestHandoff };
}
